// ProvianStorePurchase (iOS) — StoreKit 2 for the store build's two consumable purchases.
//
// The module buys and finishes; it decides nothing. A purchase hands back StoreKit's signed
// transaction (JWS) untouched, and the app sends it to the relay, which verifies it with Apple
// before anything is credited. A transaction is finished only after the relay has recorded it, so
// a purchase the relay has not yet confirmed stays unfinished and is presented again later.

import ExpoModulesCore
import StoreKit

public class ProvianStorePurchaseModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ProvianStorePurchase")

    Function("canMakePayments") { () -> Bool in
      if #available(iOS 15.0, *) { return AppStore.canMakePayments }
      return false
    }

    AsyncFunction("products") { (ids: [String]) async -> [[String: Any]] in
      guard #available(iOS 15.0, *) else { return [] }
      do {
        let products = try await Product.products(for: ids)
        return products.map { ["id": $0.id, "displayName": $0.displayName, "displayPrice": $0.displayPrice] }
      } catch {
        return []
      }
    }

    // accountToken: the UUID the relay issued for this account (Apple's appAccountToken).
    AsyncFunction("purchase") { (productId: String, accountToken: String) async -> [String: Any] in
      guard #available(iOS 15.0, *) else { return ["status": "unavailable"] }
      guard let token = UUID(uuidString: accountToken) else { return ["status": "error", "code": "bad_account_token"] }
      do {
        guard let product = try await Product.products(for: [productId]).first else {
          return ["status": "unavailable"]
        }
        let result = try await product.purchase(options: [.appAccountToken(token)])
        switch result {
        case .success(let verification):
          let transaction = ProvianStorePurchaseModule.transactionOf(verification)
          return [
            "status": "purchased",
            "productId": transaction.productID,
            "transactionId": String(transaction.id),
            "signedTransaction": verification.jwsRepresentation,
          ]
        case .userCancelled:
          return ["status": "cancelled"]
        case .pending:
          return ["status": "pending"]
        @unknown default:
          return ["status": "error", "code": "unknown_result"]
        }
      } catch {
        return ["status": "error", "code": String(describing: error)]
      }
    }

    // Every transaction not yet finished (bought, but not yet recorded by the relay).
    AsyncFunction("unfinished") { () async -> [[String: Any]] in
      guard #available(iOS 15.0, *) else { return [] }
      var out: [[String: Any]] = []
      for await verification in Transaction.unfinished {
        let transaction = ProvianStorePurchaseModule.transactionOf(verification)
        out.append([
          "status": "purchased",
          "productId": transaction.productID,
          "transactionId": String(transaction.id),
          "signedTransaction": verification.jwsRepresentation,
        ])
      }
      return out
    }

    AsyncFunction("finish") { (transactionId: String) async -> Bool in
      guard #available(iOS 15.0, *) else { return false }
      for await verification in Transaction.unfinished {
        let transaction = ProvianStorePurchaseModule.transactionOf(verification)
        if String(transaction.id) == transactionId {
          await transaction.finish()
          return true
        }
      }
      return false
    }
  }

  // The transaction either way: the relay, not the device, decides whether it is genuine.
  @available(iOS 15.0, *)
  private static func transactionOf(_ verification: VerificationResult<Transaction>) -> Transaction {
    switch verification {
    case .verified(let transaction): return transaction
    case .unverified(let transaction, _): return transaction
    }
  }
}
