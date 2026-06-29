// calread
//
// Prints the next 7 days of calendar events as a rich JSON array, for the Tasks
// subsystem (see docs/tasks.md). Unlike `dayagenda` (which emits a today-only,
// display-formatted agenda for Daily Briefing), this emits machine fields the
// Task layer needs — a stable id for dedup, ISO start/end, and the notes/url
// where Meet/Zoom links hide:
//
//   [{"id","title","start","end","allDay","location","notes","url"}]
//
// `start`/`end` are ISO-8601 with timezone offset. Prints "[]" (exit 0) if
// calendar access is denied or there are no events, so the caller always gets
// valid JSON. The macOS calendar-access prompt is attributed to the host app
// (Studio), whose Info.plist carries the usage description.

import EventKit
import Foundation

let store = EKEventStore()
var granted = false
var done = false

// macOS 14+: full access is needed to read event titles/locations/notes.
store.requestFullAccessToEvents { ok, _ in
    granted = ok
    done = true
}
// Don't block the main thread on a semaphore — EventKit's completion handler
// needs the run loop serviced to fire, so a blocking wait deadlocks. Pump the
// run loop until it does. (Same gotcha as dayagenda.)
while !done {
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
}

guard granted else {
    FileHandle.standardError.write("calendar access denied\n".data(using: .utf8)!)
    print("[]")
    exit(0)
}

let cal = Calendar.current
let start = cal.startOfDay(for: Date())
let end = cal.date(byAdding: .day, value: 7, to: start)!
let pred = store.predicateForEvents(withStart: start, end: end, calendars: nil)
let events = store.events(matching: pred).sorted { $0.startDate < $1.startDate }

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]

var items: [[String: Any]] = []
for ev in events {
    items.append([
        "id": ev.eventIdentifier ?? "",
        "title": ev.title ?? "(untitled)",
        "start": iso.string(from: ev.startDate),
        "end": iso.string(from: ev.endDate),
        "allDay": ev.isAllDay,
        "location": ev.location ?? "",
        "notes": ev.notes ?? "",
        // EKEvent.url is a URL?; stringify it. Meet/Zoom links also commonly
        // appear inside notes/location, so the caller scans all three.
        "url": ev.url?.absoluteString ?? "",
    ])
}

guard let data = try? JSONSerialization.data(withJSONObject: items),
      let json = String(data: data, encoding: .utf8) else {
    print("[]")
    exit(0)
}
print(json)
