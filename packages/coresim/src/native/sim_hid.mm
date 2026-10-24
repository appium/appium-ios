#include "sim_hid.h"

#import <dlfcn.h>
#import <mach/mach.h>
#import <xpc/xpc.h>
#include <memory>
#include <mutex>
#include "nserror_bridge.h"
#include "objc_runtime.h"
#include "sim_device.h"

namespace coresim {
namespace {
NSError* HIDError(NSString* message) {
  return [NSError errorWithDomain:@"io.appium.coresim.HID" code:1 userInfo:@{NSLocalizedDescriptionKey : message}];
}

template <typename T>
T Resolve(const char* name) {
  auto symbol = reinterpret_cast<T>(dlsym(RTLD_DEFAULT, name));
  if (!symbol) throw NativeSimUnavailableError("symbol", name, "Simulator HID transport is unavailable");
  return symbol;
}

// dtuhidd exposes the same button/vendor services used by Xcode's device controls.
// Resolve the Mach port in the target simulator, never in the host's namespace.
// These events are one-way: a send barrier confirms transport submission only.
class HIDConnection {
 public:
  explicit HIDConnection(id device, NSString* service) : state_(std::make_shared<State>()) {
    auto endpointFromPort = Resolve<xpc_endpoint_t (*)(mach_port_t)>("xpc_endpoint_create_mach_port_4sim");
    auto enableSimulator = Resolve<void (*)(xpc_connection_t)>("xpc_connection_enable_sim2host_4sim");
    NSError* error = nil;
    mach_port_t port = LookupMachPort(device, service, &error);
    if (port == MACH_PORT_NULL) throw NSErrorException(error ?: HIDError(@"Simulator HID service is unavailable"));
    xpc_endpoint_t endpoint = endpointFromPort(port);
    mach_port_deallocate(mach_task_self(), port);
    if (!endpoint) throw NSErrorException(HIDError(@"Cannot create simulator HID endpoint"));
    connection_ = xpc_connection_create_from_endpoint(endpoint);
    if (!connection_) throw NSErrorException(HIDError(@"Cannot create simulator HID connection"));
    enableSimulator(connection_);
    auto state = state_;
    xpc_connection_set_event_handler(connection_, ^(xpc_object_t event) {
      if (xpc_get_type(event) != XPC_TYPE_ERROR) return;
      std::lock_guard<std::mutex> lock(state->mutex);
      const char* description = xpc_dictionary_get_string(event, XPC_ERROR_KEY_DESCRIPTION);
      state->error = HIDError(description ? @(description) : @"Simulator HID connection failed");
    });
    xpc_connection_resume(connection_);
  }
  ~HIDConnection() { xpc_connection_cancel(connection_); }
  void Send(NSString* type, NSString* service, xpc_object_t payload) {
    xpc_object_t message = xpc_dictionary_create(nullptr, nullptr, 0);
    xpc_dictionary_set_string(message, "messageType", type.UTF8String);
    xpc_dictionary_set_string(message, "featureIdentifier", service.UTF8String);
    xpc_dictionary_set_value(message, "payload", payload);
    xpc_connection_send_message(connection_, message);
  }
  void Flush() {
    dispatch_semaphore_t sent = dispatch_semaphore_create(0);
    xpc_connection_send_barrier(connection_, ^{
      dispatch_semaphore_signal(sent);
    });
    if (dispatch_semaphore_wait(sent, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC))) {
      throw NSErrorException(HIDError(@"Timed out submitting simulator HID events"));
    }
  }
  void Finish() {
    Flush();
    // The service queues events until its virtual HID device opens. Retain the
    // connection briefly after submission, as the CoreDevice HID client does.
    [NSThread sleepForTimeInterval:0.1];
    std::lock_guard<std::mutex> lock(state_->mutex);
    if (state_->error) throw NSErrorException(state_->error);
  }

 private:
  struct State {
    std::mutex mutex;
    NSError* error = nil;
  };
  std::shared_ptr<State> state_;
  xpc_connection_t connection_;
};

}  // namespace

void SendVendorHIDEvent(id device, uint32_t page, uint32_t usage, uint64_t version, NSData* data) {
  xpc_object_t payload = xpc_dictionary_create(nullptr, nullptr, 0);
  xpc_dictionary_set_uint64(payload, "usagePage", page);
  xpc_dictionary_set_uint64(payload, "usage", usage);
  xpc_dictionary_set_uint64(payload, "version", version);
  xpc_dictionary_set_data(payload, "data", data.bytes, data.length);
  NSString* service = @"com.apple.coredevice.feature.remote.hid.vendordefined";
  HIDConnection connection(device, service);
  connection.Send(@"IndigoVendorDefinedEvent", service, payload);
  connection.Finish();
}
void PressHIDButton(id device, uint32_t page, uint32_t usage, double duration) {
  NSString* service = @"com.apple.coredevice.feature.remote.hid.button";
  HIDConnection connection(device, service);
  for (uint64_t state : {1ULL, 2ULL}) {
    xpc_object_t payload = xpc_dictionary_create(nullptr, nullptr, 0);
    xpc_dictionary_set_uint64(payload, "usagePage", page);
    xpc_dictionary_set_uint64(payload, "usageCode", usage);
    xpc_dictionary_set_uint64(payload, "state", state);
    connection.Send(@"IndigoButtonEvent", service, payload);
    if (state == 1) {
      // Start the hold interval only after XPC has submitted the down event.
      connection.Flush();
      [NSThread sleepForTimeInterval:duration];
    }
  }
  connection.Finish();
}
}  // namespace coresim
