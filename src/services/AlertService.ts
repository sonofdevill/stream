// =============================================================================
// GEMSTREAM — src/services/AlertService.ts
// Production Implementation v1.0.0
//
// GOVERNING ARCHITECTURE (see SYSTEM_ARCHITECTURE.md §7):
//   Transport:   Socket.io
//   Decoupling:  AlertService is a "dumb megaphone" — it performs zero math.
//                LedgerService commits a tip to PostgreSQL, then calls
//                AlertService.dispatchAlert() with a pre-shaped TipAlertPayload.
//                This service emits it to the correct Socket.io Room and stops.
//
//   Room Model:  Each Streamer occupies exactly one room, identified by their
//                `streamerId`. OBS browser sources join their Streamer's room
//                on WebSocket connection. Tips are emitted ONLY to that room.
//
// SECURITY INVARIANT (enforced throughout):
//   `io.to(streamerId).emit(...)` is the ONLY permitted emission path.
//   `io.emit(...)` (global broadcast) is NEVER called. A tip for Streamer A
//   must never trigger an alert on Streamer B's OBS overlay.
//
// DEPENDENCIES:
//   - socket.io  (v4 — Server, Socket)
//   - http        (Node.js built-in — http.Server for attachment)
// =============================================================================

import { Server, Socket } from "socket.io";
import type { Server as HttpServer } from "http";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Canonical TipAlertPayload as defined by SYSTEM_ARCHITECTURE.md §7.
 * This shape is the contract between LedgerService (producer) and the
 * OBS browser source widget (consumer). AlertService passes it through
 * unchanged — it never adds, removes, or transforms any field.
 */
export interface TipAlertPayload {
  /** UUID of the TipEvent record in the database */
  tipId: string;
  /** UUID of the Streamer receiving the tip — used as the Socket.io Room ID */
  streamerId: string;
  /** Display name of the tipping Viewer, shown on the OBS overlay */
  viewerUsername: string;
  /**
   * Whole Gem count transferred. Passed through as-is — AlertService performs
   * no conversion to USD/USDT (§7: dumb megaphone, zero math).
   */
  gemAmount: number;
  /** Optional message from the Viewer, or null if none was provided */
  customMessage: string | null;
}

/**
 * Socket.io event name for tip alerts (§7 canonical name).
 * OBS browser source widgets listen for this exact string.
 * A typo here would silently break every overlay in production.
 */
const TIP_EVENT_NAME = "TIP_DISPATCHED" as const;

/**
 * Socket.io event name sent by OBS browser sources after connecting.
 * The client emits this with its `streamerId` to join the correct room.
 */
const JOIN_ROOM_EVENT = "join-room" as const;

// =============================================================================
// CUSTOM ERROR CLASSES
// =============================================================================

/**
 * Thrown by `dispatchAlert()` when called before `initialize()` has run.
 *
 * Without an initialised Socket.io Server, there is no `io` instance to emit
 * through. Rather than silently dropping the alert (which would cause missed
 * OBS notifications) or crashing with a null-reference error, this named error
 * allows the orchestrator (or LedgerService) to catch it, log it, and alert
 * the on-call engineer that the service was invoked out of order.
 */
export class ServiceNotInitializedError extends Error {
  public readonly code = "SERVICE_NOT_INITIALIZED" as const;
  constructor() {
    super(
      "[AlertService] ServiceNotInitializedError: dispatchAlert() was called before " +
        "initialize(). Ensure AlertService.initialize(httpServer, origins) is called " +
        "at application startup before the first tip is processed."
    );
    this.name = "ServiceNotInitializedError";
    Object.setPrototypeOf(this, ServiceNotInitializedError.prototype);
  }
}

// =============================================================================
// CLASS: AlertService
// =============================================================================

/**
 * GemStream's real-time WebSocket alert engine (§7).
 *
 * Responsibilities:
 *  - Attaching a Socket.io Server to the Node.js http.Server at startup
 *  - Accepting connections from OBS browser source clients
 *  - Assigning each connected client to their Streamer's Socket.io Room
 *  - Emitting `TIP_DISPATCHED` events to the correct room on every confirmed tip
 *
 * Non-responsibilities (strict decoupling per §7):
 *  - No database access
 *  - No Gem-to-USD/USDT conversion or any other arithmetic
 *  - No Stripe or blockchain interaction
 *  - No modification of the TipAlertPayload
 *
 * Lifecycle:
 *   1. `new AlertService()` — instantiate (no I/O yet)
 *   2. `alertService.initialize(httpServer, allowedOrigins)` — attach Socket.io
 *   3. `alertService.dispatchAlert(payload)` — called by LedgerService per tip
 */
export class AlertService {
  /**
   * The Socket.io Server instance. Null until `initialize()` is called.
   * All `dispatchAlert()` calls must check this is non-null first.
   */
  private io: Server | null = null;

  // ===========================================================================
  // PUBLIC METHOD: initialize
  // ===========================================================================

  /**
   * Attaches a Socket.io Server to the provided Node.js http.Server and
   * configures the connection lifecycle for OBS browser source clients.
   *
   * MUST be called exactly once at application startup, after the http.Server
   * is created but before any tips are processed. Calling it multiple times
   * would register duplicate `connection` handlers, causing each tip alert
   * to be emitted once per `initialize()` call.
   *
   * CORS POLICY:
   *   The `allowedOrigins` array is used verbatim for Socket.io's CORS `origin`
   *   field. A wildcard `"*"` must never be passed — all callers must provide
   *   an explicit origin allowlist. This enforces that only known GemStream
   *   domains (dashboard, OBS overlay CDN) can establish WebSocket connections.
   *
   * @param httpServer     - The Node.js http.Server Express is bound to.
   *                         Socket.io shares this server's port — no second port.
   * @param allowedOrigins - Explicit list of origins permitted to connect.
   *                         e.g. ["https://gemstream.io", "http://localhost:3000"]
   */
  initialize(httpServer: HttpServer, allowedOrigins: string[]): void {
    // ── Attach Socket.io to the shared http.Server ────────────────────────────
    // Sharing the http.Server means WebSocket upgrades happen on the same port
    // as the REST API. No additional proxy or port configuration is required.
    this.io = new Server(httpServer, {
      cors: {
        // Explicit allowlist — never a wildcard (security requirement)
        origin: allowedOrigins,
        methods: ["GET", "POST"],
      },
    });

    // ── Register the Connection Handler ───────────────────────────────────────
    // This handler fires once per completed WebSocket handshake. The `socket`
    // argument represents the individual connection to one OBS browser source.
    this.io.on("connection", (socket: Socket) => {
      this.handleConnection(socket);
    });
  }

  // ===========================================================================
  // PRIVATE METHOD: handleConnection
  // ===========================================================================

  /**
   * Manages the lifecycle of a single OBS browser source WebSocket connection.
   *
   * CONNECTION PROTOCOL:
   *   After connecting, the OBS browser source immediately emits a `join-room`
   *   event carrying the `streamerId` of the Streamer whose overlay it belongs to.
   *   AlertService validates the `streamerId` and assigns the socket to that room.
   *
   * ROOM ASSIGNMENT:
   *   `socket.join(streamerId)` places this socket inside a named Socket.io Room.
   *   From this point, `io.to(streamerId).emit(...)` reaches this socket.
   *   Multiple OBS scenes or browser sources for the same Streamer may connect —
   *   they all join the same room and all receive the same alerts.
   *
   * INVALID streamerId POLICY:
   *   An empty string or missing `streamerId` would place the socket in room `""`
   *   or `undefined`, grouping all misconfigured clients together and potentially
   *   leaking alerts across Streamers. The socket is immediately disconnected
   *   with a warning log so the Streamer can identify and fix their OBS config.
   *
   * @param socket - The Socket.io Socket instance for this connection
   */
  private handleConnection(socket: Socket): void {
    console.info(
      `[AlertService] OBS client connected: socket=${socket.id}`
    );

    // ── 'join-room' Event: Room Assignment ───────────────────────────────────
    socket.on(JOIN_ROOM_EVENT, (streamerId: string) => {
      // Guard: empty or non-string streamerId would corrupt room assignments
      if (!streamerId || typeof streamerId !== "string" || streamerId.trim() === "") {
        console.warn(
          `[AlertService] socket=${socket.id} sent an empty or invalid streamerId. ` +
            `Disconnecting to prevent room pollution.`
        );
        // Forcibly close the connection — do NOT call socket.join()
        socket.disconnect();
        return;
      }

      // Assign the socket to the Streamer's room.
      // Room ID === streamerId (one-to-one mapping, no transformation).
      socket.join(streamerId);

      console.info(
        `[AlertService] socket=${socket.id} joined room="${streamerId}"`
      );
    });

    // ── 'disconnect' Event: Cleanup & Logging ────────────────────────────────
    // Socket.io automatically removes a disconnected socket from all rooms.
    // We register this handler to log the disconnection for observability —
    // unexpected disconnects (network drops, OBS restarts) surface here.
    socket.on("disconnect", (reason: string) => {
      console.info(
        `[AlertService] OBS client disconnected: socket=${socket.id}, reason=${reason}`
      );
    });
  }

  // ===========================================================================
  // PUBLIC METHOD: dispatchAlert
  // ===========================================================================

  /**
   * Emits a `TIP_DISPATCHED` event to the target Streamer's Socket.io Room.
   *
   * CALLED BY: LedgerService, immediately after a tip transaction commits to
   * PostgreSQL. LedgerService provides the pre-shaped `TipAlertPayload` —
   * AlertService emits it unchanged (§7: dumb megaphone, zero math).
   *
   * EMISSION PATH (the ONLY permitted path — see Security Invariant above):
   *   `this.io.to(payload.streamerId).emit('TIP_DISPATCHED', payload)`
   *
   *   - `io.to(streamerId)` scopes the emit to the named room only.
   *     Only sockets that have called `socket.join(streamerId)` receive it.
   *   - `io.emit(...)` (without `.to()`) is NEVER used. Global broadcast would
   *     deliver the tip alert to every connected OBS overlay on the platform.
   *
   * PAYLOAD CONTRACT (§7):
   *   The payload is emitted exactly as received. No fields are added, removed,
   *   or mutated. The OBS browser source widget deserialises this object directly.
   *
   * @param payload - Pre-validated TipAlertPayload from LedgerService
   * @throws ServiceNotInitializedError if called before `initialize()`
   */
  dispatchAlert(payload: TipAlertPayload): void {
    // ── Initialization Guard ──────────────────────────────────────────────────
    // A null `io` means `initialize()` has not been called yet.
    // Throwing a named error here prevents a silent null-reference crash and
    // gives the orchestrator a catchable, loggable signal.
    if (!this.io) {
      throw new ServiceNotInitializedError();
    }

    // ── Room-Targeted Emission (Security Invariant) ───────────────────────────
    // `io.to(payload.streamerId)` returns a BroadcastOperator scoped to the room.
    // Only sockets in that room (i.e., OBS sources for this Streamer) receive the event.
    // The payload is passed through as-is — zero transformation (§7).
    this.io.to(payload.streamerId).emit(TIP_EVENT_NAME, payload);

    console.info(
      `[AlertService] TIP_DISPATCHED emitted to room="${payload.streamerId}" ` +
        `tipId=${payload.tipId} gems=${payload.gemAmount} from=${payload.viewerUsername}`
    );
  }
}
