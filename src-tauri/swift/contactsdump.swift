// contactsdump
//
// Dumps the local macOS Address Book as JSON for Mycelium's "match Mac
// Contacts" feature — a one-shot, read-only export the JS side matches
// against Mycelium people (by email/phone first, falling back to name):
//
//   [{"name":"Full Name","emails":["a@b.com"],"phones":["+15551234567"]}]
//
// Phones are stripped to digits (leading `+` kept) so JS matching doesn't
// need to normalize formatting differences. Prints "[]" (exit 0) if Contacts
// access is denied or a contact has no name/email/phone, so the caller
// always gets valid JSON. The macOS Contacts-access prompt is attributed to
// the host app (Studio), whose Info.plist carries the usage description.

import Contacts
import Foundation

let store = CNContactStore()
var granted = false
var done = false

store.requestAccess(for: .contacts) { ok, _ in
    granted = ok
    done = true
}
// Don't block the main thread on a semaphore — the completion handler needs
// the run loop serviced to fire (same gotcha as calread/dayagenda).
while !done {
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
}

guard granted else {
    FileHandle.standardError.write("contacts access denied\n".data(using: .utf8)!)
    print("[]")
    exit(0)
}

func digitsOnly(_ s: String) -> String {
    var out = ""
    for ch in s {
        if ch.isNumber { out.append(ch) }
        else if ch == "+" && out.isEmpty { out.append(ch) }
    }
    return out
}

let keys: [CNKeyDescriptor] = [
    CNContactGivenNameKey as CNKeyDescriptor,
    CNContactFamilyNameKey as CNKeyDescriptor,
    CNContactEmailAddressesKey as CNKeyDescriptor,
    CNContactPhoneNumbersKey as CNKeyDescriptor,
]
let request = CNContactFetchRequest(keysToFetch: keys)

var items: [[String: Any]] = []
try? store.enumerateContacts(with: request) { contact, _ in
    let name = [contact.givenName, contact.familyName]
        .filter { !$0.isEmpty }
        .joined(separator: " ")
    let emails = contact.emailAddresses.map { String($0.value) }
    let phones = contact.phoneNumbers.map { digitsOnly($0.value.stringValue) }.filter { !$0.isEmpty }
    guard !name.isEmpty, !emails.isEmpty || !phones.isEmpty else { return }
    items.append(["name": name, "emails": emails, "phones": phones])
}

guard let data = try? JSONSerialization.data(withJSONObject: items),
      let json = String(data: data, encoding: .utf8) else {
    print("[]")
    exit(0)
}
print(json)
