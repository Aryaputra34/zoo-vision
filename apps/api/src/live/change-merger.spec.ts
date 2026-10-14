import { ChangeMerger, type DataChanged } from './change-merger';

const change = (
  cameraIds: string[],
  useCases: string[],
  shapes: DataChanged['shapes'],
): DataChanged => ({ cameraIds, useCases, shapes });

describe('ChangeMerger', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const setup = (windowMs = 5000) => {
    const sent: DataChanged[] = [];
    const merger = new ChangeMerger(windowMs, (c) => sent.push(c));
    return { sent, merger };
  };

  it('the first change is sent at once; three more within 5 s are sent as one merged message at 5 s', () => {
    const { sent, merger } = setup();

    merger.add(change(['cam_a'], ['vehicle_gate'], ['event']));
    expect(sent).toEqual([change(['cam_a'], ['vehicle_gate'], ['event'])]);

    jest.advanceTimersByTime(1000);
    merger.add(change(['cam_b'], ['vehicle_gate'], ['metric']));
    jest.advanceTimersByTime(1000);
    merger.add(change(['cam_a'], ['horse_riding'], ['interval']));
    jest.advanceTimersByTime(1000);
    merger.add(change(['cam_c'], ['vehicle_gate'], ['event']));
    expect(sent).toHaveLength(1);

    jest.advanceTimersByTime(1999);
    expect(sent).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(sent).toHaveLength(2);
    // set unions, sorted, no repeats
    expect(sent[1]).toEqual(
      change(
        ['cam_a', 'cam_b', 'cam_c'],
        ['horse_riding', 'vehicle_gate'],
        ['event', 'interval', 'metric'],
      ),
    );

    jest.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(2);
  });

  it('a change after a quiet window is sent at once again', () => {
    const { sent, merger } = setup();
    merger.add(change(['a'], ['u'], ['event']));
    jest.advanceTimersByTime(5001); // nothing was waiting: the window just closes
    expect(sent).toHaveLength(1);

    merger.add(change(['b'], ['u'], ['metric']));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(change(['b'], ['u'], ['metric']));
  });

  it('after a merged message the next window is closed too: a change right after it waits', () => {
    const { sent, merger } = setup();
    merger.add(change(['a'], ['u'], ['event'])); // t=0, sent
    jest.advanceTimersByTime(100);
    merger.add(change(['b'], ['u'], ['event'])); // waits
    jest.advanceTimersByTime(4900); // t=5000: merged message sent
    expect(sent).toHaveLength(2);

    jest.advanceTimersByTime(100);
    merger.add(change(['c'], ['u'], ['event'])); // t=5100: inside the new window
    expect(sent).toHaveLength(2);
    jest.advanceTimersByTime(4900); // t=10000
    expect(sent).toHaveLength(3);
    expect(sent[2].cameraIds).toEqual(['c']);
  });

  it('sends at most one message per window however many changes arrive', () => {
    const { sent, merger } = setup();
    for (let i = 0; i < 500; i++) {
      merger.add(change([`cam_${i % 7}`], ['u'], ['metric']));
      jest.advanceTimersByTime(10);
    }
    // 5 s of changes: the first at once, one merged at 5 s
    expect(sent.length).toBeLessThanOrEqual(2);
    jest.advanceTimersByTime(5000);
    expect(sent.length).toBeLessThanOrEqual(3);
  });

  it('close() drops what is waiting and cancels the timer', () => {
    const { sent, merger } = setup();
    merger.add(change(['a'], ['u'], ['event']));
    merger.add(change(['b'], ['u'], ['event']));
    merger.close();
    jest.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a throwing emit does not break the merger', () => {
    const calls: DataChanged[] = [];
    let fail = true;
    const merger = new ChangeMerger(5000, (c) => {
      calls.push(c);
      if (fail) throw new Error('socket gone');
    });
    expect(() => merger.add(change(['a'], ['u'], ['event']))).not.toThrow();
    fail = false;
    jest.advanceTimersByTime(5001);
    merger.add(change(['b'], ['u'], ['event']));
    expect(calls).toHaveLength(2);
  });
});
