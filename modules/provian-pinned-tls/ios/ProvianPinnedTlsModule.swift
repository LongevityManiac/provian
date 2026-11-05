// ProvianPinnedTLS (iOS) — pinned-DNS TLS fetch.
//
// Connects to a PRE-VALIDATED IP while setting the TLS SNI + certificate
// validation to the ORIGINAL hostname. This is the correct fix for review #33:
// the SSRF layer (JS) resolves + validates every IP is public, then this module
// connects to that exact IP so DNS cannot rebind to an internal address after
// the check — while TLS still validates the hostname's certificate (so real
// merchant/CDN certs validate, unlike the old raw-IP-URL + Host-header hack).
//
// Implemented with Network.framework (NWConnection) because URLSession exposes
// no per-request DNS override that preserves correct SNI. We set
// sec_protocol_options_set_tls_server_name(hostname) and connect to the IP.
//
// !!! DEVICE-VERIFY REQUIRED !!! This compiles against the Expo Modules API but
// has NOT been exercised on a physical device. Verify against a real HTTPS
// endpoint (and a real x402 / merchant endpoint) before relying on it.

import ExpoModulesCore
import Network
import Foundation

struct PinnedRequest: Record {
  @Field var url: String = ""
  @Field var pinnedIp: String = ""
  @Field var hostname: String = ""
  @Field var method: String = "GET"
  @Field var headers: [String: String] = [:]
  @Field var body: String? = nil
  @Field var followRedirects: Bool = false
  // WS4: hard byte cap (OOM defense) + configurable timeout.
  @Field var maxBytes: Int = 1_000_000
  @Field var timeoutMs: Int = 30_000
}

public class ProvianPinnedTlsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ProvianPinnedTLS")

    AsyncFunction("fetch") { (request: PinnedRequest, promise: Promise) in
      PinnedTLSClient.perform(request: request, promise: promise)
    }
  }
}

private final class PinnedTLSClient {
  // Strong registry keeps each in-flight client alive until it completes
  // (NWConnection handlers capture `self` weakly to avoid a retain cycle).
  private static let registryLock = NSLock()
  private static var registry: [PinnedTLSClient] = []

  static func perform(request: PinnedRequest, promise: Promise) {
    let client = PinnedTLSClient(request: request, promise: promise)
    registryLock.lock()
    registry.append(client)
    registryLock.unlock()
    client.start()
  }

  private let request: PinnedRequest
  private let promise: Promise
  private var connection: NWConnection?
  private var received = Data()
  private var didFinish = false
  private let queue = DispatchQueue(label: "ai.provian.pinnedtls")

  private init(request: PinnedRequest, promise: Promise) {
    self.request = request
    self.promise = promise
  }

  func start() {
    guard let url = URL(string: request.url), url.host != nil else {
      finishError("INVALID_URL", "Invalid URL")
      return
    }
    let port = UInt16(url.port ?? 443)

    // Connect to the PRE-VALIDATED IP, but pin TLS SNI + cert validation to the
    // hostname so the server returns and we validate the correct certificate.
    let tlsOptions = NWProtocolTLS.Options()
    sec_protocol_options_set_tls_server_name(tlsOptions.securityProtocolOptions, request.hostname)
    let params = NWParameters(tls: tlsOptions)

    let endpoint = NWEndpoint.hostPort(
      host: NWEndpoint.Host(request.pinnedIp),
      port: NWEndpoint.Port(rawValue: port) ?? 443
    )
    let conn = NWConnection(to: endpoint, using: params)
    self.connection = conn

    let timeoutSeconds = Double(max(1, request.timeoutMs)) / 1000.0
    queue.asyncAfter(deadline: .now() + timeoutSeconds) { [weak self] in
      self?.finishError("TIMEOUT", "Pinned TLS request timed out")
    }

    conn.stateUpdateHandler = { [weak self] state in
      guard let self = self else { return }
      switch state {
      case .ready:
        self.sendRequest(url: url)
      case .failed(let error):
        self.finishError("CONNECTION_FAILED", error.localizedDescription)
      default:
        break
      }
    }
    conn.start(queue: queue)
  }

  private func sendRequest(url: URL) {
    var path = url.path.isEmpty ? "/" : url.path
    if let q = url.query { path += "?\(q)" }
    let bodyData = request.body?.data(using: .utf8) ?? Data()
    let method = request.method.uppercased()

    var head = "\(method) \(path) HTTP/1.1\r\n"
    head += "Host: \(request.hostname)\r\n"
    var hasContentLength = false
    for (k, v) in request.headers {
      let lower = k.lowercased()
      if lower == "host" { continue }
      if lower == "content-length" { hasContentLength = true }
      head += "\(k): \(v)\r\n"
    }
    if (method == "POST" || method == "PUT" || method == "PATCH") && !hasContentLength {
      head += "Content-Length: \(bodyData.count)\r\n"
    }
    // Avoid gzip so we can return the body as plain text without inflating.
    head += "Accept-Encoding: identity\r\n"
    head += "Connection: close\r\n"
    head += "\r\n"

    var packet = head.data(using: .utf8) ?? Data()
    packet.append(bodyData)

    connection?.send(content: packet, completion: .contentProcessed { [weak self] error in
      if let error = error {
        self?.finishError("SEND_FAILED", error.localizedDescription)
        return
      }
      self?.receiveLoop()
    })
  }

  private func receiveLoop() {
    connection?.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
      guard let self = self else { return }
      if let data = data, !data.isEmpty {
        self.received.append(data)
        // WS4: abort before buffering an oversized (potentially OOM) response.
        if self.received.count > self.request.maxBytes {
          self.connection?.cancel()
          self.finishError("RESPONSE_TOO_LARGE", "Response exceeded \(self.request.maxBytes) bytes")
          return
        }
      }
      if let error = error {
        self.finishError("RECEIVE_FAILED", error.localizedDescription)
        return
      }
      if isComplete {
        self.parseAndFinish()
      } else {
        self.receiveLoop()
      }
    }
  }

  private func parseAndFinish() {
    let separator = Data("\r\n\r\n".utf8)
    guard let headerEnd = received.range(of: separator) else {
      finishError("BAD_RESPONSE", "No header terminator in response")
      return
    }
    let headerData = received.subdata(in: received.startIndex..<headerEnd.lowerBound)
    var bodyData = received.subdata(in: headerEnd.upperBound..<received.endIndex)

    let headerText = String(decoding: headerData, as: UTF8.self)
    let lines = headerText.components(separatedBy: "\r\n")
    guard let statusLine = lines.first else {
      finishError("BAD_RESPONSE", "Empty response")
      return
    }
    let statusParts = statusLine.components(separatedBy: " ")
    let status = statusParts.count >= 2 ? (Int(statusParts[1]) ?? 0) : 0

    var headers: [String: String] = [:]
    var isChunked = false
    for line in lines.dropFirst() {
      guard let colon = line.firstIndex(of: ":") else { continue }
      let name = String(line[line.startIndex..<colon]).trimmingCharacters(in: .whitespaces)
      let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
      headers[name] = value
      if name.lowercased() == "transfer-encoding" && value.lowercased().contains("chunked") {
        isChunked = true
      }
    }

    if isChunked {
      bodyData = PinnedTLSClient.dechunk(bodyData)
    }

    finishSuccess(status: status, headers: headers, body: String(decoding: bodyData, as: UTF8.self))
  }

  private static func dechunk(_ data: Data) -> Data {
    var result = Data()
    var index = data.startIndex
    let crlf = Data("\r\n".utf8)
    while index < data.endIndex {
      guard let lineEnd = data.range(of: crlf, in: index..<data.endIndex) else { break }
      let sizeLine = String(decoding: data.subdata(in: index..<lineEnd.lowerBound), as: UTF8.self)
      let sizeToken = sizeLine.components(separatedBy: ";").first ?? sizeLine
      guard let chunkSize = Int(sizeToken.trimmingCharacters(in: .whitespaces), radix: 16), chunkSize > 0 else { break }
      let chunkStart = lineEnd.upperBound
      guard let chunkEnd = data.index(chunkStart, offsetBy: chunkSize, limitedBy: data.endIndex) else { break }
      result.append(data.subdata(in: chunkStart..<chunkEnd))
      // Skip the trailing CRLF after the chunk payload.
      index = data.index(chunkEnd, offsetBy: 2, limitedBy: data.endIndex) ?? data.endIndex
    }
    return result
  }

  private func finishSuccess(status: Int, headers: [String: String], body: String) {
    queue.async { [weak self] in
      guard let self = self, !self.didFinish else { return }
      self.didFinish = true
      self.connection?.cancel()
      self.promise.resolve([
        "status": status,
        "headers": headers,
        "body": body,
      ])
      self.release()
    }
  }

  private func finishError(_ code: String, _ message: String) {
    queue.async { [weak self] in
      guard let self = self, !self.didFinish else { return }
      self.didFinish = true
      self.connection?.cancel()
      self.promise.reject(code, message)
      self.release()
    }
  }

  private func release() {
    PinnedTLSClient.registryLock.lock()
    PinnedTLSClient.registry.removeAll { $0 === self }
    PinnedTLSClient.registryLock.unlock()
  }
}
