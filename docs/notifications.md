# Notification Center

Pi Web's notification center is a **projection** over source state: pi-web
never stores the notifications themselves. Sources own their data (watchdog
writes `~/.openviking/watchdog-state.json`, cron keeps its own store, …); the
API projects source state into `NotificationItem`s at request time.

Two independent state maps are the only persisted pi-web state (see
`lib/notification-dismiss.ts`):

| map | layer | key | written by | meaning |
|---|---|---|---|---|
| `hidden` | reminder | occurrence `id` | notification list (trash / Clear all) + arrival suppression | "this occurrence is not a reminder" |
| `alertOff` | error | `namespace:source` | Errors-panel switch only | "don't alert me about future occurrences of this error line" (durable) |

## Architecture

```
source state (watchdog.py / cron / …)
        │  read at request time
        ▼
lib/notification-sources.ts        ← SOURCE REGISTRY (add a source = one entry)
  NOTIFICATION_SOURCES = [watchdogSource, …]
  aggregateSources() → merged items + per-source failures
        │
        ▼
GET /api/notifications             lib/notifications.ts (pure)
  ├─ buildNotificationView(items, {hidden, alertOff}) → dto + badge
  │    · arrival-during-mute → suppressed & persisted into `hidden`
  └─ GC of stale hidden ids (only when EVERY source loaded OK)
        ▲
POST /api/notifications/dismiss        reminder layer: hide ids (trash / Clear all)
POST /api/notifications/alert-policy   error layer: mute/unmute one error line
        │
        ▼
NotificationCenter (bell + badge, sidebar next to the Pi Web title)
  └─ NotificationsModal      reminder layer: undismissed items only
       └─ row click → NOTIFICATION_JUMP_EVENT → AppShell opens the owner UI
ErrorDetailsModal (top-bar "Errors" button, ⚠ icon)
  └─ data layer: ALL items; one switch per error line = its FUTURE alert policy
```

Two deliberate layers (错误管错误,通知管通知):

- **Reminder layer** (`NotificationsModal`): only undismissed items. Knows
  nothing about errors — clicking a row dispatches a jump event so the owning
  interface opens focused on that item. Trash / Clear all write `hidden` only.
- **Error layer** (`ErrorDetailsModal`): the full projection. Its per-row
  switch writes `alertOff` only — muting/unmuting NEVER changes which
  notifications are currently visible; it arms/disarms future arrivals.

## Invariants (do not break)

1. **Ids carry generation + namespace.**
   `id = ${namespace}:${fingerprint}:${first_seen}`. A recurrence after its
   source entry expired gets a fresh id; the namespace keeps ids from
   different sources collision-free.
2. **Restore arms the future only.** An occurrence that arrived while its line
   was muted is suppressed *at arrival* and persisted into `hidden`
   (`buildNotificationView` reports it as `newlyHidden`), so deleting
   `alertOff` can never resurrect it: notification stays unchanged **until a
   new error arrives** (2026-09-26 requirement).
3. **Muting never hides pre-existing notifications.** Suppression requires
   `createdAt > alertOff[key]` — the error layer manages the future, the
   reminder layer manages the present.
4. **Clear all sends a snapshot.** The client posts the ids it rendered, never
   "hide everything active" — an error created after the snapshot stays
   visible. See `hideIds()` in `lib/notification-dismiss.ts`.
5. **Hidden items stay in `dtos`.** The data layer still shows them (dimmed);
   hiding removes a reminder, never data.
6. **Partial degradation.** One dead source contributes zero items and lands
   in `failures[]`; the others keep serving. GC of `hidden` runs only when
   EVERY source loaded OK — a failed source's dismissals must survive its
   outage.

These are pinned by tests in `lib/notifications.test.mjs`.

## Adding a new notification source

Example: cron job failures should alert. **You never edit the API route.**

### 1. Projector + registry entry (one file)

In `lib/notification-sources.ts`:

```ts
const cronSource: NotificationSource = {
  id: "cron",                         // → also the id namespace
  load(): SourceResult {
    try {
      const jobs = readCronStore();   // your source's own state
      return {
        items: jobs.filter(j => j.lastRunStatus === "error").map((job): NotificationItem => ({
          id: notificationId("cron", `job/${job.id}`, job.lastFailedAtSeconds),
          namespace: "cron",
          source: `job/${job.id}`,
          origin: "cron",
          kind: "任务失败",
          level: "error",
          title: `cron · ${job.name}`,
          body: job.lastError ?? "",
          createdAt: job.lastFailedAtSeconds * 1000,
          updatedAt: job.lastFailedAtSeconds * 1000,
          count: job.failCount ?? 1,
          action: "cron",             // jump target (step 3)
        })),
        lastRun: /* source's own last update, ms */,
      };
    } catch (error) {
      return { items: [], lastRun: 0, error: String(error) };  // degrade alone
    }
  },
};

export const NOTIFICATION_SOURCES = [watchdogSource, cronSource]; // ← the only route-side change
```

Rules:
- `load()` must **not throw** — return `{error}` instead (invariant 6).
- `id` must be built with `notificationId(namespace, …)` (invariant 1).
- `action` is the click target; `"errors"` jumps to the Errors panel.

### 2. Jump wiring (only if the source has its own UI)

- `NotificationAction` gains `"cron"` (in `lib/notifications.ts`).
- In `AppShell`, the `NOTIFICATION_JUMP_EVENT` listener opens the owning
  panel focused on `detail.errorId`. No UI yet → keep `action: "errors"`.

### 3. i18n

Add source-specific `notifications.*` keys to **all three** language packs
(`lib/i18n/messages/{en,zh-CN,zh-TW}.ts`). Notification titles/bodies usually
embed source strings — localize what you control, don't fabricate
translations for third-party error text.

### 4. Acceptance checklist

- [ ] `tsc --noEmit`, `npm run lint`, `npm test` all green (add unit tests for
      your projector: id generation, sorting, level inference, and a
      `aggregateSources` case where your source dies alone).
- [ ] Badge = undismissed count; a **fresh error increments the badge** even
      right after "Clear all" and while its line is muted-after-restore
      (pinned in `lib/notifications.test.mjs` — add a case for your source).
- [ ] Row click opens the owning UI focused on that item.
- [ ] The Errors switch mutes only that line's future: toggling it does not
      change the badge or the notification list.
- [ ] One dead source doesn't take down the whole endpoint or wipe another
      source's `hidden`/`alertOff`.
- [ ] Verify visually (dev on :30142; screenshot with
      `opencli browser … screenshot --tab <page-id>` — background tabs serve
      stale frames, so assert DOM state with `eval` in the same breath).

## Persisted state

`~/.pi/agent/pi-web-notification-state.json` —
`{ version: 2, hidden: {id: ms}, alertOff: {"ns:source": ms} }`, written
atomically via `writePrivateFileAtomicSync`. v1 files (`{dismissed}`) migrate
on load. GC: stale `hidden` ids are dropped when their source issue
disappears (a recurrence then yields a fresh id and re-alerts); `alertOff`
entries are durable user preferences and are never garbage-collected.
