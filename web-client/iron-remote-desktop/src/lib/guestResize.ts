export interface GuestSize {
    width: number;
    height: number;
}

export interface GuestResizeOptions {
    /** Minimum time between two resize requests (guacd's display-update interval). */
    intervalMs?: number;
    /** How long an unanswered request waits before it is sent again. */
    retryMs?: number;
    /** Requests sent at `retryMs` for one target size before slowing down to `slowRetryMs`. */
    maxAttempts?: number;
    /**
     * Retry interval once `maxAttempts` went unanswered. Windows opens Display Control only once
     * a user is logged on, so the size wanted at the logon screen is applied when that happens.
     */
    slowRetryMs?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

const RECENT_REQUESTS = 4;

function sameSize(a: GuestSize | null | undefined, b: GuestSize | null | undefined): boolean {
    return !!a && !!b && a.width === b.width && a.height === b.height;
}

/**
 * Paces guest (Display Control) resize requests while the container is being resized.
 *
 * The latest wanted size is sent immediately, then at most once per `intervalMs`, until the
 * guest reports that size. A request the guest never answers (Display Control not open yet) is
 * re-sent after `retryMs`, and after `maxAttempts` such tries every `slowRetryMs`. When the guest
 * settles on a size that was never requested, it chose its own (a server limit): that target is
 * dropped until the container asks for a different size.
 */
export class GuestResizeScheduler {
    private readonly intervalMs: number;
    private readonly retryMs: number;
    private readonly maxAttempts: number;
    private readonly slowRetryMs: number;
    private readonly now: () => number;
    private readonly setTimer: (fn: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;

    private wanted: GuestSize | null = null;
    private guest: GuestSize | null = null;
    private declined: GuestSize | null = null;
    private recent: GuestSize[] = [];
    private attempts = 0;
    private lastSentAt = Number.NEGATIVE_INFINITY;
    private sendTimer: unknown = null;
    private retryTimer: unknown = null;
    private disposed = false;

    constructor(
        private readonly send: (size: GuestSize) => void,
        options: GuestResizeOptions = {},
    ) {
        this.intervalMs = options.intervalMs ?? 500;
        this.retryMs = options.retryMs ?? 2000;
        this.maxAttempts = options.maxAttempts ?? 5;
        this.slowRetryMs = options.slowRetryMs ?? 5000;
        this.now = options.now ?? (() => Date.now());
        this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    }

    /** The container now wants `wanted`; the guest currently has `guest`. */
    update(wanted: GuestSize, guest: GuestSize): void {
        if (!sameSize(this.wanted, wanted)) {
            this.attempts = 0;
        }
        this.wanted = { ...wanted };
        this.guest = { ...guest };
        this.pump();
    }

    /** The guest finished a resize and now has `size`. */
    guestResized(size: GuestSize): void {
        this.guest = { ...size };
        this.cancelRetry();
        if (!this.recent.some((request) => sameSize(request, size)) && this.wanted && !sameSize(this.wanted, size)) {
            this.declined = { ...this.wanted };
        }
        this.pump();
    }

    dispose(): void {
        this.disposed = true;
        this.cancelSend();
        this.cancelRetry();
    }

    private pump(): void {
        const wanted = this.wanted;
        if (this.disposed || !wanted || !this.guest) {
            return;
        }
        if (sameSize(wanted, this.guest)) {
            this.cancelSend();
            this.cancelRetry();
            this.attempts = 0;
            return;
        }
        if (sameSize(wanted, this.declined)) {
            return;
        }
        const wait = this.lastSentAt + this.intervalMs - this.now();
        if (wait > 0) {
            if (this.sendTimer === null) {
                this.sendTimer = this.setTimer(() => {
                    this.sendTimer = null;
                    this.pump();
                }, wait);
            }
            return;
        }
        this.attempts += 1;
        this.lastSentAt = this.now();
        this.recent = [{ ...wanted }, ...this.recent].slice(0, RECENT_REQUESTS);
        this.send({ ...wanted });
        this.cancelRetry();
        this.retryTimer = this.setTimer(
            () => {
                this.retryTimer = null;
                this.pump();
            },
            this.attempts < this.maxAttempts ? this.retryMs : this.slowRetryMs,
        );
    }

    private cancelSend(): void {
        if (this.sendTimer !== null) {
            this.clearTimer(this.sendTimer);
            this.sendTimer = null;
        }
    }

    private cancelRetry(): void {
        if (this.retryTimer !== null) {
            this.clearTimer(this.retryTimer);
            this.retryTimer = null;
        }
    }
}
