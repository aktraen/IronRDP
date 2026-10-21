import { describe, it, expect, beforeEach } from 'vitest';
import { GuestResizeScheduler, type GuestSize } from './guestResize';

/**
 * Guest resize pacing: a container resize must reach the guest over the open session quickly,
 * without flooding it while the user drags, and must never loop against a server that settles on
 * its own size. A fake clock drives the scheduler deterministically.
 */

class FakeClock {
    time = 0;
    private timers: { at: number; fn: () => void; id: number }[] = [];
    private nextId = 1;

    now = (): number => this.time;

    setTimer = (fn: () => void, ms: number): unknown => {
        const id = this.nextId++;
        this.timers.push({ at: this.time + ms, fn, id });
        return id;
    };

    clearTimer = (handle: unknown): void => {
        this.timers = this.timers.filter((t) => t.id !== handle);
    };

    advance(ms: number): void {
        const end = this.time + ms;
        for (;;) {
            const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0] as
                | { at: number; fn: () => void; id: number }
                | undefined;
            if (due === undefined) break;
            this.timers = this.timers.filter((t) => t.id !== due.id);
            this.time = due.at;
            due.fn();
        }
        this.time = end;
    }
}

const size = (width: number, height: number): GuestSize => ({ width, height });

describe('GuestResizeScheduler', () => {
    let clock: FakeClock;
    let sent: GuestSize[];
    let scheduler: GuestResizeScheduler;

    beforeEach(() => {
        clock = new FakeClock();
        sent = [];
        scheduler = new GuestResizeScheduler((s) => sent.push(s), {
            now: clock.now,
            setTimer: clock.setTimer,
            clearTimer: clock.clearTimer,
        });
    });

    it('sends the first request immediately', () => {
        scheduler.update(size(1600, 900), size(1280, 720));
        expect(sent).toEqual([size(1600, 900)]);
    });

    it('skips a request when the guest already has the wanted size', () => {
        scheduler.update(size(1280, 720), size(1280, 720));
        clock.advance(5000);
        expect(sent).toEqual([]);
    });

    it('sends at most one request per interval and always the latest size', () => {
        scheduler.update(size(1300, 720), size(1280, 720));
        clock.advance(100);
        scheduler.update(size(1400, 760), size(1280, 720));
        clock.advance(100);
        scheduler.update(size(1500, 800), size(1280, 720));
        expect(sent).toEqual([size(1300, 720)]);
        clock.advance(300);
        expect(sent).toEqual([size(1300, 720), size(1500, 800)]);
    });

    it('stops once the guest reports the wanted size', () => {
        scheduler.update(size(1600, 900), size(1280, 720));
        scheduler.guestResized(size(1600, 900));
        clock.advance(10000);
        expect(sent).toEqual([size(1600, 900)]);
    });

    it('retries an unanswered request quickly, then slowly', () => {
        scheduler.update(size(1600, 900), size(1280, 720));
        clock.advance(8000);
        expect(sent).toHaveLength(5);
        clock.advance(52000);
        expect(sent).toHaveLength(15);
        expect(sent.every((s) => s.width === 1600 && s.height === 900)).toBe(true);
    });

    it('applies the size once the guest starts answering (Windows after logon)', () => {
        scheduler.update(size(1600, 900), size(1280, 720));
        clock.advance(30000);
        const before = sent.length;
        scheduler.guestResized(size(1600, 900));
        clock.advance(30000);
        expect(sent).toHaveLength(before);
    });

    it('starts counting attempts again for a new wanted size', () => {
        scheduler.update(size(1600, 900), size(1280, 720));
        clock.advance(60000);
        const before = sent.length;
        scheduler.update(size(1000, 700), size(1280, 720));
        expect(sent).toHaveLength(before + 1);
        expect(sent[before]).toEqual(size(1000, 700));
        clock.advance(2000);
        expect(sent).toHaveLength(before + 2);
    });

    it('does not insist when the guest settles on a size of its own', () => {
        scheduler.update(size(4000, 3000), size(1280, 720));
        scheduler.guestResized(size(3840, 2160));
        clock.advance(60000);
        expect(sent).toEqual([size(4000, 3000)]);
    });

    it('treats an answer to an older request as progress, not a refusal', () => {
        scheduler.update(size(1300, 720), size(1280, 720));
        clock.advance(500);
        scheduler.update(size(1500, 800), size(1280, 720));
        expect(sent).toEqual([size(1300, 720), size(1500, 800)]);
        scheduler.guestResized(size(1300, 720));
        clock.advance(2000);
        expect(sent[sent.length - 1]).toEqual(size(1500, 800));
        expect(sent.length).toBeGreaterThan(2);
    });

    it('sends nothing after dispose', () => {
        scheduler.update(size(1300, 720), size(1280, 720));
        scheduler.update(size(1500, 800), size(1280, 720));
        scheduler.dispose();
        clock.advance(10000);
        expect(sent).toEqual([size(1300, 720)]);
    });
});
