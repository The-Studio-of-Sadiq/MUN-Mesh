package expo.modules.nearby

import com.google.android.gms.common.api.ApiException
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android Nearby Connections, as thin as possible: advertise, discover,
 * connect, and move text. Everything else (who to link with, framing,
 * ordering) is in @mun/core's nearby.ts, where it can be tested.
 *
 * Connections are accepted automatically: every message on them is signed
 * and checked by the app, and devices from another conference are ignored
 * by name before anyone connects.
 */
class NearbyModule : Module() {
  private var client: ConnectionsClient? = null
  /** Whether each pending connection was asked for by the other phone. */
  private val incoming = HashMap<String, Boolean>()

  private fun emit(type: String, endpoint: String, extra: Map<String, Any?> = emptyMap()) {
    sendEvent("onNearby", mapOf("type" to type, "endpoint" to endpoint) + extra)
  }

  private val payloads = object : PayloadCallback() {
    override fun onPayloadReceived(endpointId: String, payload: Payload) {
      val bytes = payload.asBytes() ?: return
      emit("data", endpointId, mapOf("text" to String(bytes, Charsets.UTF_8)))
    }

    override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {}
  }

  private val lifecycle = object : ConnectionLifecycleCallback() {
    override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
      incoming[endpointId] = info.isIncomingConnection
      client?.acceptConnection(endpointId, payloads)
    }

    override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
      val wasIncoming = incoming.remove(endpointId) ?: false
      if (result.status.isSuccess) emit("connected", endpointId, mapOf("incoming" to wasIncoming))
      else emit("disconnected", endpointId)
    }

    override fun onDisconnected(endpointId: String) {
      emit("disconnected", endpointId)
    }
  }

  private val discovery = object : EndpointDiscoveryCallback() {
    override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
      emit("found", endpointId, mapOf("name" to info.endpointName))
    }

    override fun onEndpointLost(endpointId: String) {
      emit("lost", endpointId)
    }
  }

  /** "Already advertising/discovering" isn't a failure. */
  private fun alreadyRunning(e: Exception): Boolean {
    val code = (e as? ApiException)?.statusCode
    return code == ConnectionsStatusCodes.STATUS_ALREADY_ADVERTISING || code == ConnectionsStatusCodes.STATUS_ALREADY_DISCOVERING
  }

  private fun stopAll() {
    client?.let {
      it.stopAdvertising()
      it.stopDiscovery()
      it.stopAllEndpoints()
    }
    incoming.clear()
  }

  override fun definition() = ModuleDefinition {
    Name("MunNearby")
    Events("onNearby")

    AsyncFunction("start") { serviceId: String, name: String, promise: Promise ->
      val context = appContext.reactContext?.applicationContext
      if (context == null) {
        promise.reject("ERR_NEARBY", "No Android context", null)
        return@AsyncFunction
      }
      val c = client ?: Nearby.getConnectionsClient(context).also { client = it }
      val strategy = Strategy.P2P_CLUSTER
      c.startAdvertising(name, serviceId, lifecycle, AdvertisingOptions.Builder().setStrategy(strategy).build())
        .continueWithTask { adv ->
          val e = adv.exception
          if (e != null && !alreadyRunning(e)) throw e
          c.startDiscovery(serviceId, discovery, DiscoveryOptions.Builder().setStrategy(strategy).build())
        }
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { e ->
          if (alreadyRunning(e)) promise.resolve(null) else promise.reject("ERR_NEARBY", e.message, e)
        }
    }

    AsyncFunction("stop") {
      stopAll()
    }

    AsyncFunction("connect") { endpoint: String, name: String, promise: Promise ->
      val c = client
      if (c == null) {
        promise.reject("ERR_NEARBY", "Nearby isn't running", null)
        return@AsyncFunction
      }
      c.requestConnection(name, endpoint, lifecycle)
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { e -> promise.reject("ERR_NEARBY", e.message, e) }
    }

    AsyncFunction("send") { endpoint: String, text: String, promise: Promise ->
      val c = client
      if (c == null) {
        promise.reject("ERR_NEARBY", "Nearby isn't running", null)
        return@AsyncFunction
      }
      c.sendPayload(endpoint, Payload.fromBytes(text.toByteArray(Charsets.UTF_8)))
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { e -> promise.reject("ERR_NEARBY", e.message, e) }
    }

    Function("disconnect") { endpoint: String ->
      client?.disconnectFromEndpoint(endpoint)
    }

    OnDestroy {
      stopAll()
    }
  }
}
