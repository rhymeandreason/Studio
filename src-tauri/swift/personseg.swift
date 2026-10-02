// personseg — long-running person-segmentation helper (Vision framework).
//
// Speaks length-prefixed frames over stdin/stdout so Rust can stay a dumb pipe
// (`person_mask` in personseg.rs). Each request / reply is a little-endian u32
// byte count followed by that many bytes:
//
//   request payload:  u16 w, u16 h, then w*h*4 RGBA bytes
//   reply payload:    u16 w, u16 h, then w*h bytes of mask (0 = background,
//                     255 = person), at Vision's own mask resolution
//
// One VNSequenceRequestHandler for the whole run, so Vision can keep the mask
// temporally stable from frame to frame. Used by the Camera Bubble tool.

import Foundation
import Vision
import CoreVideo

let stdin = FileHandle.standardInput
let stdout = FileHandle.standardOutput

func readExactly(_ n: Int) -> Data? {
    var data = Data(capacity: n)
    while data.count < n {
        let chunk = stdin.readData(ofLength: n - data.count)
        if chunk.isEmpty { return nil } // EOF: Studio went away
        data.append(chunk)
    }
    return data
}

func u16(_ d: Data, _ at: Int) -> Int { Int(d[d.startIndex + at]) | Int(d[d.startIndex + at + 1]) << 8 }

func writeFrame(_ payload: Data) {
    var len = UInt32(payload.count).littleEndian
    stdout.write(Data(bytes: &len, count: 4))
    stdout.write(payload)
}

let request = VNGeneratePersonSegmentationRequest()
request.qualityLevel = .balanced
request.outputPixelFormat = kCVPixelFormatType_OneComponent8
let sequence = VNSequenceRequestHandler()
let colorSpace = CGColorSpaceCreateDeviceRGB()

while let header = readExactly(4) {
    let len = Int(header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian })
    guard let body = readExactly(len) else { break }

    var mw = 0, mh = 0
    var mask = Data()
    let w = len >= 4 ? u16(body, 0) : 0
    let h = len >= 4 ? u16(body, 2) : 0
    if w > 0, h > 0, len == 4 + w * h * 4,
       let provider = CGDataProvider(data: body.subdata(in: (body.startIndex + 4)..<body.endIndex) as CFData),
       let image = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                           space: colorSpace,
                           bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                           provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
       (try? sequence.perform([request], on: image)) != nil,
       let buffer = request.results?.first?.pixelBuffer {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        mw = CVPixelBufferGetWidth(buffer)
        mh = CVPixelBufferGetHeight(buffer)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        if let base = CVPixelBufferGetBaseAddress(buffer) {
            mask.reserveCapacity(mw * mh)
            for y in 0..<mh { mask.append(base.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self), count: mw) }
        }
        CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
    }

    // A failed frame still gets a reply (an empty 0×0 mask) so the pipe stays in step.
    if mw == 0 || mask.count != mw * mh { writeFrame(Data([0, 0, 0, 0])); continue }
    writeFrame(Data([UInt8(mw & 0xff), UInt8(mw >> 8), UInt8(mh & 0xff), UInt8(mh >> 8)]) + mask)
}
