// ProvianStorePurchase (Android) — Google Play Billing for the Play build's two consumable purchases.
//
// The module buys and consumes; it decides nothing. A purchase hands back Play's purchase token,
// and the app sends it to the relay, which verifies it with Google Play before anything is
// credited. A purchase is consumed only after the relay has recorded it, so one the relay has not
// yet confirmed stays unconsumed and is presented again later (and Play refunds a purchase nobody
// acknowledged within three days).
package expo.modules.provianstorepurchase

import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ProvianStorePurchaseModule : Module() {
  private var client: BillingClient? = null
  private var pendingPurchase: Promise? = null

  private val purchasesUpdated = PurchasesUpdatedListener { result, purchases ->
    val promise = pendingPurchase ?: return@PurchasesUpdatedListener
    pendingPurchase = null
    when (result.responseCode) {
      BillingClient.BillingResponseCode.OK -> {
        val purchase = purchases?.firstOrNull()
        promise.resolve(if (purchase == null) mapOf("status" to "error", "code" to "no_purchase") else purchaseMap(purchase))
      }
      BillingClient.BillingResponseCode.USER_CANCELED -> promise.resolve(mapOf("status" to "cancelled"))
      BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> promise.resolve(mapOf("status" to "already_owned"))
      else -> promise.resolve(mapOf("status" to "error", "code" to "billing_${result.responseCode}"))
    }
  }

  private fun purchaseMap(purchase: Purchase): Map<String, Any?> = mapOf(
    "status" to when (purchase.purchaseState) {
      Purchase.PurchaseState.PURCHASED -> "purchased"
      Purchase.PurchaseState.PENDING -> "pending"
      else -> "error"
    },
    "productId" to purchase.products.firstOrNull(),
    "transactionId" to purchase.orderId,
    "purchaseToken" to purchase.purchaseToken,
  )

  private fun withClient(onReady: (BillingClient) -> Unit, onFail: (String) -> Unit) {
    val existing = client
    if (existing != null && existing.isReady) {
      onReady(existing)
      return
    }
    val context = appContext.reactContext ?: run { onFail("no_context"); return }
    val fresh = BillingClient.newBuilder(context)
      .setListener(purchasesUpdated)
      .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
      .build()
    client = fresh
    fresh.startConnection(object : BillingClientStateListener {
      override fun onBillingSetupFinished(result: BillingResult) {
        if (result.responseCode == BillingClient.BillingResponseCode.OK) onReady(fresh) else onFail("billing_${result.responseCode}")
      }
      override fun onBillingServiceDisconnected() {
        client = null
      }
    })
  }

  private fun productParams(ids: List<String>): QueryProductDetailsParams =
    QueryProductDetailsParams.newBuilder()
      .setProductList(ids.map {
        QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(BillingClient.ProductType.INAPP).build()
      })
      .build()

  override fun definition() = ModuleDefinition {
    Name("ProvianStorePurchase")

    Function("canMakePayments") { true }

    AsyncFunction("products") { ids: List<String>, promise: Promise ->
      withClient({ billing ->
        billing.queryProductDetailsAsync(productParams(ids)) { result, details ->
          if (result.responseCode != BillingClient.BillingResponseCode.OK) {
            promise.resolve(emptyList<Map<String, Any?>>())
            return@queryProductDetailsAsync
          }
          promise.resolve(details.productDetailsList.map {
            mapOf("id" to it.productId, "displayName" to it.name, "displayPrice" to it.oneTimePurchaseOfferDetails?.formattedPrice)
          })
        }
      }, { promise.resolve(emptyList<Map<String, Any?>>()) })
    }

    // accountToken: the id the relay issued for this account (Play's obfuscatedAccountId).
    AsyncFunction("purchase") { productId: String, accountToken: String, promise: Promise ->
      if (pendingPurchase != null) {
        promise.resolve(mapOf("status" to "error", "code" to "purchase_in_progress"))
        return@AsyncFunction
      }
      withClient({ billing ->
        billing.queryProductDetailsAsync(productParams(listOf(productId))) { result, details ->
          val product = details.productDetailsList.firstOrNull()
          val activity = appContext.currentActivity
          if (result.responseCode != BillingClient.BillingResponseCode.OK || product == null || activity == null) {
            promise.resolve(mapOf("status" to "unavailable"))
            return@queryProductDetailsAsync
          }
          val params = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(product).build()))
            .setObfuscatedAccountId(accountToken)
            .build()
          pendingPurchase = promise
          val launched = billing.launchBillingFlow(activity, params)
          if (launched.responseCode != BillingClient.BillingResponseCode.OK) {
            pendingPurchase = null
            promise.resolve(mapOf("status" to "error", "code" to "billing_${launched.responseCode}"))
          }
        }
      }, { code -> promise.resolve(mapOf("status" to "unavailable", "code" to code)) })
    }

    // Every purchase not yet consumed (bought, but not yet recorded by the relay).
    AsyncFunction("unfinished") { promise: Promise ->
      withClient({ billing ->
        billing.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build()) { result, purchases ->
          if (result.responseCode != BillingClient.BillingResponseCode.OK) {
            promise.resolve(emptyList<Map<String, Any?>>())
            return@queryPurchasesAsync
          }
          promise.resolve(purchases.map { purchaseMap(it) })
        }
      }, { promise.resolve(emptyList<Map<String, Any?>>()) })
    }

    AsyncFunction("finish") { purchaseToken: String, promise: Promise ->
      withClient({ billing ->
        billing.consumeAsync(ConsumeParams.newBuilder().setPurchaseToken(purchaseToken).build()) { result, _ ->
          promise.resolve(result.responseCode == BillingClient.BillingResponseCode.OK)
        }
      }, { promise.resolve(false) })
    }
  }
}
