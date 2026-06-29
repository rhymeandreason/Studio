// transit
//
// Estimates travel time between two addresses for the Tasks subsystem's
// in-person "Leave now" lead time (see docs/tasks.md). Geocodes both addresses
// (CLGeocoder) and asks MapKit for an ETA (MKDirections):
//
//   transit "<from address>" "<to address>" [driving|walking]
//   -> {"minutes": 27, "mode": "driving"}      (on success)
//   -> {"error": "…"}                          (on failure; exit 0)
//
// Only driving/walking are supported — MKDirections doesn't return headless
// transit ETAs. Needs network. Like the EventKit helpers, the async callbacks
// need the run loop pumped (a blocking semaphore would deadlock).

import CoreLocation
import Foundation
import MapKit

func fail(_ msg: String) -> Never {
    let obj = ["error": msg]
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    } else {
        print("{\"error\":\"unknown\"}")
    }
    exit(0)
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: transit <from> <to> [driving|walking]") }
let fromAddr = args[1]
let toAddr = args[2]
let mode = args.count >= 4 ? args[3].lowercased() : "driving"
let transport: MKDirectionsTransportType = (mode == "walking") ? .walking : .automobile

let geocoder = CLGeocoder()

// Street-address lookup. Precise for real addresses, but fails on place/POI
// names ("San Rafael public library").
func geocode(_ address: String) -> CLLocationCoordinate2D? {
    var result: CLLocationCoordinate2D?
    var done = false
    geocoder.geocodeAddressString(address) { placemarks, _ in
        result = placemarks?.first?.location?.coordinate
        done = true
    }
    while !done {
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
    return result
}

// Natural-language place search — resolves POIs/landmarks the geocoder can't.
// An optional region anchors an ambiguous query ("public library") near the
// user's origin.
func placeSearch(_ query: String, near: CLLocationCoordinate2D? = nil) -> CLLocationCoordinate2D? {
    var result: CLLocationCoordinate2D?
    var done = false
    let req = MKLocalSearch.Request()
    req.naturalLanguageQuery = query
    if let near = near {
        req.region = MKCoordinateRegion(
            center: near,
            span: MKCoordinateSpan(latitudeDelta: 1.5, longitudeDelta: 1.5))
    }
    MKLocalSearch(request: req).start { resp, err in
        result = resp?.mapItems.first?.placemark.coordinate
        if result == nil, let err = err {
            FileHandle.standardError.write("placeSearch(\(query)): \(err.localizedDescription)\n".data(using: .utf8)!)
        }
        done = true
    }
    while !done {
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
    return result
}

// Address first, then POI search as a fallback (anchored near `hint` if given).
func locate(_ address: String, near hint: CLLocationCoordinate2D? = nil) -> CLLocationCoordinate2D? {
    geocode(address) ?? placeSearch(address, near: hint)
}

guard let fromCoord = locate(fromAddr) else {
    fail("could not locate origin: \(fromAddr)")
}
// Anchor the destination POI search near the origin for ambiguous names.
guard let toCoord = locate(toAddr, near: fromCoord) else {
    fail("could not locate destination: \(toAddr)")
}

let req = MKDirections.Request()
req.source = MKMapItem(placemark: MKPlacemark(coordinate: fromCoord))
req.destination = MKMapItem(placemark: MKPlacemark(coordinate: toCoord))
req.transportType = transport

var minutes: Int?
var etaErr: String?
var done = false
MKDirections(request: req).calculateETA { resp, err in
    if let resp = resp {
        minutes = Int((resp.expectedTravelTime / 60.0).rounded())
    } else {
        etaErr = err?.localizedDescription ?? "no route"
    }
    done = true
}
while !done {
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
}

guard let mins = minutes else { fail(etaErr ?? "no ETA") }

let obj: [String: Any] = ["minutes": mins, "mode": mode]
if let data = try? JSONSerialization.data(withJSONObject: obj),
   let s = String(data: data, encoding: .utf8) {
    print(s)
} else {
    print("{\"minutes\":\(mins),\"mode\":\"\(mode)\"}")
}
