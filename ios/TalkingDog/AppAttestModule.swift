import Foundation
import DeviceCheck
import CryptoKit

/// React Native bridge for Apple's DCAppAttestService.
///
/// Usage (JS side — see AppAttestService.ts):
///   1. AppAttestModule.generateKey() → keyId (base64-url SHA256 of public key)
///   2. AppAttestModule.attestKey(keyId, challengeB64) → attestation (base64)
///      • challengeB64 must be the fresh challenge from GET /v1/attest/challenge
///   3. Per request: AppAttestModule.generateAssertion(keyId, requestBodyJSON) → assertion (base64)
///
/// Limitations:
///   - DCAppAttestService.shared.isSupported returns false on the iOS Simulator.
///     The JS layer handles this by skipping assertion headers in dev mode.

@objc(AppAttestModule)
class AppAttestModule: NSObject {

  private let service = DCAppAttestService.shared

  // MARK: - Generate Key

  @objc func generateKey(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard service.isSupported else {
      reject("NOT_SUPPORTED", "App Attest is not supported on this device (Simulator?)", nil)
      return
    }

    service.generateKey { keyId, error in
      if let error = error {
        reject("GENERATE_KEY_ERROR", error.localizedDescription, error)
        return
      }
      resolve(keyId as AnyObject?)
    }
  }

  // MARK: - Attest Key

  /// - Parameter challengeB64: Base64-encoded challenge bytes returned by GET /v1/attest/challenge
  @objc func attestKey(
    _ keyId: String,
    challengeB64: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard service.isSupported else {
      reject("NOT_SUPPORTED", "App Attest is not supported on this device (Simulator?)", nil)
      return
    }
    guard let challengeData = Data(base64Encoded: challengeB64) else {
      reject("INVALID_CHALLENGE", "challengeB64 is not valid base64", nil)
      return
    }

    // The clientDataHash passed to Apple must be SHA256(challenge)
    let hash = Data(SHA256.hash(data: challengeData))

    service.attestKey(keyId, clientDataHash: hash) { attestation, error in
      if let error = error {
        reject("ATTEST_ERROR", error.localizedDescription, error)
        return
      }
      resolve(attestation?.base64EncodedString() as AnyObject?)
    }
  }

  // MARK: - Generate Assertion

  /// - Parameter requestBodyJSON: The exact JSON string that will be sent as the request body.
  ///   The worker computes SHA256(requestBodyJSON) as clientDataHash during verification.
  @objc func generateAssertion(
    _ keyId: String,
    requestBodyJSON: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard service.isSupported else {
      // On the Simulator, return nil so the JS layer skips adding the assertion header
      resolve(nil as AnyObject?)
      return
    }
    guard let bodyData = requestBodyJSON.data(using: .utf8) else {
      reject("INVALID_BODY", "requestBodyJSON could not be encoded as UTF-8", nil)
      return
    }

    let hash = Data(SHA256.hash(data: bodyData))

    service.generateAssertion(keyId, clientDataHash: hash) { assertion, error in
      if let error = error {
        reject("ASSERTION_ERROR", error.localizedDescription, error)
        return
      }
      resolve(assertion?.base64EncodedString() as AnyObject?)
    }
  }

  // MARK: - RCT export

  @objc static func requiresMainQueueSetup() -> Bool { false }
}
