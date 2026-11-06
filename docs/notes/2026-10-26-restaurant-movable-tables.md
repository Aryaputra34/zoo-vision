# Restaurant tables move: findings and open questions

Date: 2026-10-26. Status: notes, not a spec. The design is on hold until the client answers the questions at the end.

## The problem

The `restaurant_table` use case assumes every table stays in one place. Each table is a polygon drawn by hand on the camera image (`tables` in the camera settings). A person counts toward a table when their head, torso, centre or feet fall inside its polygon (`services/engine/core/table_manager.py`, `test_detection`). The engine only detects people. It never looks at the tables.

At the restaurant the tables are not fixed. Staff shift them a little, and push two or more together for big groups.

## What the footage shows

Clip: `restoran.mp4`, camera "RF AREA MAKAN 2 LT. 1", 27/06/2030 11:56 to 12:54, 1920x1080 at 15 fps. We pulled one frame about every 5 minutes, drew the configured zones on it (yellow), and ran `yolo11s` with all classes: people in red, chairs in blue, `dining table` in magenta.

**1. Tables get joined, and the join lasts for hours.** At 11:56 the table with card 33 (zone T3) and the table in zone T7 are separate. At 12:11 a group arrives and table 33 is pulled against the T7 table. They are still joined at 12:16, 12:25 and 12:49, with different groups sitting at them. So a join is a layout change, not a one-meal event.

| 11:56, separate | 12:11, being joined | 12:16, joined and in use |
|---|---|---|
| ![](assets/restaurant-movable-tables/1156-separate.jpg) | ![](assets/restaurant-movable-tables/1211-joining.jpg) | ![](assets/restaurant-movable-tables/1216-joined.jpg) |

**2. The current zones do not fit this camera, even before anything moves.** At 11:56 the empty table at left-centre, between zones T5, T4, T1 and T6, is not covered by any zone, and T3 and T7 overlap a lot. The zones in `services/engine/configs/rules/restaurant_table.yaml` were probably drawn for another day or layout.

**3. Table detection only works when the room is quiet.**

| Frame | `dining table` boxes |
|---|---|
| 11:56, sparse | 15, confidence 0.16 to 0.50, some doubled or partial |
| Crowded frames | 1 to 7 |
| 12:11, brighter exposure | 0 |

The joined table was detected as one box (0.23 at 12:16). Detecting tables could help re-locate them at quiet moments. It cannot run all the time.

**4. The tables carry number cards** (26, 33, 34, 38). They do not match our ids T1 to T15. Table names should use the restaurant's numbers so that staff and reports refer to the same table.

## What goes wrong today

- **A table moves out of its zone.** Its diners land outside the polygon. The table shows vacant while people eat, and after 15 s (`empty_debounce_sec`) the session closes.
- **A table moves into a neighbour's zone.** Its diners count toward the wrong table. At the joined 33 and T7 table, people on the far side fall into the T9 and T13 zones.
- **Diners at the edge of a zone.** People near the edge drift in and out, so one meal can be split into several short sessions.
- **Tables are joined.** The group gets two or more sessions, one per table (sessions are keyed by table id). Session counts and turnover go up, and average dwell goes down.

## Directions we discussed (tentative)

These were agreed in discussion, assuming that both floor staff and management will use the numbers. They may change once the client answers.

- **The system notices and a person confirms.** At quiet moments the engine compares where it sees tables with their zones. When a table looks moved or joined, it raises a suggestion with a snapshot. An operator accepts it, adjusts it, or rejects it in the web UI. Accepting saves a normal config version, so the change keeps versioning, live reload and the audit log.
  - Rejected: fully automatic changes. The detector is too weak, and a wrong guess would change zones silently for hours.
  - Rejected: manual redrawing only. It depends on someone noticing, which is what failed today.
- **While a suggestion waits, keep counting with the old zones and flag the tables "needs check."** The flag appears in the live view, and on the sessions recorded in that window. Pausing those tables would leave holes in the data. Applying the suggestion early could put wrong data in silently.
- **Sketch of the settings change** (not agreed yet):
  - Each table gets an optional `surface` polygon: the table top the detector sees, next to the existing seating `polygon`. A move shifts both shapes by the same offset.
  - Joined tables become a `joins` list on the camera settings, for example `{id: "J1", tables: ["T3", "T7"]}`. A joined group has one session and one dwell timer.
  - Table ids never change.
- **Signals for noticing a move or a join:**
  - Table-top detection at quiet moments.
  - Seated people lingering where there is no zone.

## Gemini's "Dynamic Anchor & Memory Engine" proposal

We reviewed the proposal and its prototype in `scratch/table_prototype/`. We are not adopting it as written.

- **The prototype does much less than the write-up says.** `test_table_memory.py` detects tables once at 01:00 and applies those fixed boxes to one frame at 26:50. The "decay after 60 s" and "register a new spot from seated diners" parts are not in the code. The "benchmark" is 4 still frames.
- **Its own result (12:23) shows the problems:**
  - The joined 33 and T7 table appears as two separate tables at their old positions.
  - Tables the detector missed (the window tables at top-left, the group at far right) never appear, so they can never count as occupied.
  - A 4-seat table shows "7p", because the box-plus-margin rule pulls in people from neighbouring tables.
- **Bugs in `test_dynamic_table_occupancy.py`:**
  - Line 53 computes the person's centre y from `x2` instead of `y2`.
  - In the merge loop, the `dy` gap uses `x2` instead of `y2`.
  - The merge rule ("close together and both occupied") merges two separate groups at neighbouring tables.
- **It has no stable table identity,** so there are no per-table dwell or turnover numbers.
- **It is fully automatic,** which is the option we rejected above.
- **Worth keeping:** using seated people as evidence that a table has moved.

## Option: a second camera for the far half

This is not decided. It depends on the client's answers and on how well the far tables can be read.

**Why.** Everything struggles in the far half of the room:
- The existing config had to lower the person-confidence threshold for the far tables (T9 to 0.12, T5 to 0.15).
- Table detection is weakest there.
- Any marker or tag on a far table would be squashed by the camera angle.

A second camera at the back of the room, looking the other way, would turn the far tables into near tables. It costs hardware, installation and compute for one more stream. Add it only if the far tables stay unreliable after the zones are redrawn and tested.

**Rule if we add one: each table belongs to exactly one camera.**
- Each camera has its own settings and its own table list. Reports group sessions by camera plus table id, so the same id on two cameras is two different tables.
- A table both cameras can see is configured only on the camera with the better view. Overlap in the picture does not matter, because only configured tables are counted.
- Room-level numbers are then camera A plus camera B. Check whether the dashboard already adds the cameras together for a restaurant.
- Draw the dividing line along a natural gap, such as an aisle or a pillar. A join cannot cross the line, because today's settings only join tables on the same camera. If staff often push together tables from both sides, move the line.
- The cost: no backup view. If diners block a table from its camera, the other camera's view is not used.

**Not recommended: fusing both cameras' views of the same table.** That needs both cameras calibrated to one floor plan, synchronised frames, and merged detections. It is a much bigger project, and only worth it if occlusion becomes the main problem. In this footage the main problem is tables moving and being joined, not occlusion.

## Questions for the client

Most important first.

1. **Per table or whole room?** Do you need numbers for each table ("table 33 turned over 6 times, average stay 48 min"), or only for the room (occupancy %, average dwell, number of free tables)?
2. **Who looks at it?** Floor staff on a live screen while seating guests, management in reports, or both?
3. **Is someone available during service?** Can a supervisor or cashier answer a prompt such as "table 33 looks moved, confirm?" Or must it run with no one involved?
4. **Joined tables:** when two tables are pushed together, does that count as one table in use or two?
5. **How often does the layout change?** Only for big groups, or also for events and weekends? Does staff put everything back at closing?
6. **Scale:** how many dining areas, cameras and outlets? Could a second camera be mounted at the back of this dining area if the far tables need it?
7. **Cost of a mistake:** what does a wrong reading cost? For example, guests sent to a table that is taken, or reports that are slightly off.

### How the answers change the design

- **Per-table numbers needed (Q1).** We need stable table ids and the confirm-a-suggestion flow. That means a new suggestion record in the API, a review screen in the FE, and the `surface` and `joins` settings. This is a multi-week feature.
- **Room-level numbers only (Q1).** Table identity stops mattering. A mostly automatic approach becomes reasonable, closer to Gemini's idea once its bugs are fixed and missed tables are handled, with much less API and FE work.
- **No one can answer prompts (Q3).** The confirm flow is pointless. We would either accept automatic changes with their errors, or limit the product to room-level numbers.
- **The layout is reset every day (Q5).** Re-checking the layout once at opening may be enough, so continuous checking during service may not be needed.

## Next steps

1. Bring the questions above to the client.
2. With the answers, resume the design (brainstorming, then a spec in `docs/superpowers/specs/`, then a plan).
3. Whichever way it goes: before any demo on this camera, redraw the zones on a current empty-room frame (finding 2).
