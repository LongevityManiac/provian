import Foundation

enum TestError: Error { case upload }
var time: TimeInterval = 0
var reads = 0
try ICloudUploadConfirmation.wait(timeout: 3, state: {
  reads += 1
  return .init(uploaded: reads >= 3, uploading: reads < 3, error: nil)
}, now: { time }, pause: { time += 1 })
precondition(reads == 3, "must wait for cloud acknowledgement")

for state in [
  ICloudUploadConfirmation.State(uploaded: nil, uploading: nil, error: nil),
  .init(uploaded: false, uploading: false, error: nil),
  .init(uploaded: true, uploading: true, error: nil)
] {
  time = 0
  do {
    try ICloudUploadConfirmation.wait(timeout: 2, state: { state }, now: { time }, pause: { time += 1 })
    fatalError("local, unknown or still uploading must time out")
  } catch ICloudUploadConfirmation.Failure.timeout { precondition(time == 2) }
}
do {
  try ICloudUploadConfirmation.wait(timeout: 2, state: { .init(uploaded: true, uploading: false, error: TestError.upload) })
  fatalError("upload error must fail even with stale uploaded flag")
} catch TestError.upload {}
print("iCloud upload confirmation: 5 cases passed")
