// dayagenda
//
// Prints today's calendar events as a JSON array:
//   [{"time":"10:00–10:30","title":"…","location":"…"}]
// All-day events use "All day"; events are sorted by start time. Prints "[]"
// (and exits 0) if calendar access is denied or there are no events, so the
// caller always gets valid JSON. The macOS calendar-access prompt is attributed
// to the host app (Studio), whose Info.plist carries the usage description.

import EventKit
import Foundation

let store = EKEventStore()
var granted = false
var done = false

// macOS 14+: full access is needed to read event titles/locations.
store.requestFullAccessToEvents { ok, _ in
    granted = ok
    done = true
}
// Don't block the main thread on a semaphore — EventKit's completion handler
// needs the run loop serviced to fire, so a blocking wait deadlocks (the prompt
// is granted but the callback never runs). Pump the run loop until it does.
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
let end = cal.date(byAdding: .day, value: 1, to: start)!
let pred = store.predicateForEvents(withStart: start, end: end, calendars: nil)
let events = store.events(matching: pred).sorted { $0.startDate < $1.startDate }

let df = DateFormatter()
df.dateFormat = "HH:mm"

var items: [[String: String]] = []
for ev in events {
    let time = ev.isAllDay
        ? "All day"
        : "\(df.string(from: ev.startDate))–\(df.string(from: ev.endDate))"
    items.append([
        "time": time,
        "title": ev.title ?? "(untitled)",
        "location": ev.location ?? "",
    ])
}

guard let data = try? JSONSerialization.data(withJSONObject: items),
      let json = String(data: data, encoding: .utf8) else {
    print("[]")
    exit(0)
}
print(json)
