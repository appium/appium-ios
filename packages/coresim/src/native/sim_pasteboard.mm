#include "sim_pasteboard.h"

#import <AppKit/AppKit.h>
#import <dlfcn.h>
#import <objc/message.h>

#include "nserror_bridge.h"
#include "objc_runtime.h"
#include "safe_dispatch.h"
#include "sim_device.h"

// Bridges SimPasteboardInterface's delegate callbacks to plain dispatch semaphores. Not declared
// `<SimPasteboardDelegate>` — that protocol has no compile-time header, but matching selector
// names is all Objective-C dispatch needs. Sits outside coresim:: since ObjC declarations can't
// live inside a C++ namespace.
@interface CoresimPasteboardDelegate : NSObject
@property(atomic) dispatch_semaphore_t activeSema;
@property(atomic) dispatch_semaphore_t appliedSema;
@property(atomic, strong) NSError* appliedError;
@property(atomic) BOOL connectionLost;
@end

@implementation CoresimPasteboardDelegate

- (void)simPasteboardDidBecomeActive:(id)interface {
  dispatch_semaphore_signal(self.activeSema);
}

- (void)simPasteboardDidLoseConnection:(id)interface {
  // Flip the flag before signalling — both waiters below check it after waking, so a disconnect
  // must never look like a plain successful wakeup.
  self.connectionLost = YES;
  dispatch_semaphore_signal(self.activeSema);
  dispatch_semaphore_signal(self.appliedSema);
}

- (BOOL)simPasteboardShouldApplySnapshot:(id)interface
                                fromHost:(NSUUID*)host
                              generation:(long long)generation
                            toPasteboard:(NSPasteboard*)pasteboard {
  return YES;
}

- (void)simPasteboardDidApplySnapshot:(id)interface
                             fromHost:(NSUUID*)host
                   incomingGeneration:(long long)incomingGeneration
                         toPasteboard:(NSPasteboard*)pasteboard
                         atGeneration:(long long)atGeneration {
  dispatch_semaphore_signal(self.appliedSema);
}

- (void)simPasteboardErrorApplyingSnapshot:(id)interface
                                  fromHost:(NSUUID*)host
                                generation:(long long)generation
                                     error:(NSError*)error
                              toPasteboard:(NSPasteboard*)pasteboard {
  self.appliedError = error;
  dispatch_semaphore_signal(self.appliedSema);
}

- (void)simPasteboardDidChangeAutoNotifyState:(id)interface
                                forPasteboard:(NSPasteboard*)pasteboard
                                     toStatus:(BOOL)status {
}

@end

namespace coresim {

namespace {

NSString* const kPasteboardErrorDomain = @"io.appium.coresim.Pasteboard";

// The UTI both pasteboard mechanisms below exchange plain text under.
NSString* const kPlainTextUTI = @"public.utf8-plain-text";

constexpr auto kSimPasteboardPlusPath =
    "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Frameworks/"
    "SimPasteboardPlus.framework/Versions/A/SimPasteboardPlus";

constexpr auto kListenerClassName = "_TtC17SimPasteboardPlus30SimPasteboardInterfaceListener";
constexpr auto kInterfaceClassName = "_TtC17SimPasteboardPlus22SimPasteboardInterface";

// Unlike CoreSimDeviceIO, this isn't pulled in by loading CoreSimulator.framework itself — must be
// dlopen()'d explicitly before NSClassFromString can find its classes.
bool EnsureSimPasteboardPlusLoaded() {
  static const bool loaded = dlopen(kSimPasteboardPlusPath, RTLD_NOW | RTLD_LOCAL) != nullptr;
  return loaded;
}

// The real availability gate: -[SimDevice respondsToSelector:@selector(pasteboard)] stays true on
// CoreSimulator releases that have already dropped the legacy item class behind it, so the modern
// path's own class presence — not that selector — decides which mechanism to use.
bool ModernPasteboardAvailable() {
  return EnsureSimPasteboardPlusLoaded() && NSClassFromString(@(kListenerClassName)) != nil;
}

// Swift `@objc` classes with no ObjC rename — resolve only by their mangled runtime name, not the
// clean one (see CLAUDE.md).
Class RequireListenerClass() { return RequireClass(kListenerClassName); }
Class RequireInterfaceClass() { return RequireClass(kInterfaceClassName); }

NSError* MakeError(NSInteger code, NSString* message) {
  return [NSError errorWithDomain:kPasteboardErrorDomain code:code userInfo:@{NSLocalizedDescriptionKey : message}];
}

constexpr int64_t kOperationTimeoutSeconds = 10;
// -push has no completion callback (see CLAUDE.md) — an arbitrary safety margin, not a value
// Apple documents or guarantees.
constexpr double kPushSettleSeconds = 0.5;

// Shared setup for pull/push: resolves the sync service's Mach port in `device`'s bootstrap
// namespace and connects a SimPasteboardInterface to it, waiting (bounded) for it to go active.
id ConnectPasteboardInterface(id device, NSPasteboard* pasteboard, CoresimPasteboardDelegate* delegate,
                              dispatch_queue_t queue) {
  Class listenerClass = RequireListenerClass();
  Class interfaceClass = RequireInterfaceClass();

  NSString* serviceName = SafeInvoke([&] {
    using Fn = id (*)(id, SEL);
    return ((Fn)objc_msgSend)((id)listenerClass, NSSelectorFromString(@"machServiceName"));
  });

  NSError* lookupError = nil;
  unsigned int port = LookupMachPort(device, serviceName, &lookupError);
  // The port is the authoritative success signal, not the error (see CLAUDE.md).
  if (port == 0) {
    throw NSErrorException(
        lookupError
            ?: MakeError(1, [NSString stringWithFormat:@"No mach port named '%@' is registered in the "
                                                       @"device's bootstrap namespace — is it booted?",
                                                       serviceName]));
  }

  id interface = SafeInvoke([&] {
    id allocedInterface = [interfaceClass alloc];  // ARC-safe: alloc is a recognized family method
    // initWithConnectingToPort:... is resolved dynamically, so the compiler can't apply its usual
    // init-family ARC bookkeeping — ns_consumed/ns_returns_retained spell it out by hand instead
    // (getting this wrong either leaks the interface or over-releases and crashes).
    using InitFn =
        id (*__attribute__((ns_returns_retained)))(id __attribute__((ns_consumed)), SEL, unsigned int, id, id, id);
    return ((InitFn)objc_msgSend)(
        allocedInterface, NSSelectorFromString(@"initWithConnectingToPort:managingPasteboard:delegate:delegateQueue:"),
        port, pasteboard, delegate, queue);
  });
  if (interface == nil) {
    throw NSErrorException(MakeError(2, @"Failed to construct a connection to the device's pasteboard"));
  }

  // Bounded, not DISPATCH_TIME_FOREVER — a device shutting down mid-operation could hang forever
  // otherwise (simPasteboardDidLoseConnection: also signals this semaphore for a prompt failure).
  long timedOut = dispatch_semaphore_wait(delegate.activeSema,
                                          dispatch_time(DISPATCH_TIME_NOW, kOperationTimeoutSeconds * NSEC_PER_SEC));
  if (timedOut != 0) {
    throw NSErrorException(MakeError(6, @"Timed out waiting for the device's pasteboard connection to activate"));
  }
  if (delegate.connectionLost) {
    throw NSErrorException(MakeError(7, @"Lost the connection to the device's pasteboard before it became active"));
  }
  return interface;
}

NSString* PullPasteboardStringModern(id device, NSError** error) {
  NSPasteboard* pasteboard = [NSPasteboard pasteboardWithUniqueName];
  @try {
    CoresimPasteboardDelegate* delegate = [CoresimPasteboardDelegate new];
    delegate.activeSema = dispatch_semaphore_create(0);
    delegate.appliedSema = dispatch_semaphore_create(0);
    dispatch_queue_t queue = dispatch_queue_create("io.appium.coresim.pasteboard.pull", DISPATCH_QUEUE_SERIAL);

    id interface = ConnectPasteboardInterface(device, pasteboard, delegate, queue);
    SafeInvoke([&] {
      ((void (*)(id, SEL))objc_msgSend)(interface, NSSelectorFromString(@"pull"));
      return true;
    });

    long timedOut = dispatch_semaphore_wait(delegate.appliedSema,
                                            dispatch_time(DISPATCH_TIME_NOW, kOperationTimeoutSeconds * NSEC_PER_SEC));
    if (timedOut != 0) {
      throw NSErrorException(MakeError(3, @"Timed out waiting for the device's pasteboard contents"));
    }
    if (delegate.connectionLost) {
      throw NSErrorException(MakeError(8, @"Lost the connection to the device's pasteboard before it applied"));
    }
    if (delegate.appliedError != nil) {
      throw NSErrorException(delegate.appliedError);
    }
    return [pasteboard stringForType:NSPasteboardTypeString] ?: @"";
  } @finally {
    [pasteboard releaseGlobally];
  }
}

BOOL PushPasteboardStringModern(id device, NSString* content, NSError** error) {
  NSPasteboard* pasteboard = [NSPasteboard pasteboardWithUniqueName];
  @try {
    [pasteboard clearContents];
    [pasteboard setString:content forType:NSPasteboardTypeString];

    CoresimPasteboardDelegate* delegate = [CoresimPasteboardDelegate new];
    delegate.activeSema = dispatch_semaphore_create(0);
    delegate.appliedSema = dispatch_semaphore_create(0);
    dispatch_queue_t queue = dispatch_queue_create("io.appium.coresim.pasteboard.push", DISPATCH_QUEUE_SERIAL);

    id interface = ConnectPasteboardInterface(device, pasteboard, delegate, queue);
    SafeInvoke([&] {
      ((void (*)(id, SEL))objc_msgSend)(interface, NSSelectorFromString(@"push"));
      return true;
    });
    [NSThread sleepForTimeInterval:kPushSettleSeconds];
    // No completion callback to wait on (see kPushSettleSeconds above), but a disconnect during
    // the settle sleep is still a real, already-known failure — report it instead of a false YES.
    if (delegate.connectionLost) {
      throw NSErrorException(MakeError(9, @"Lost the connection to the device's pasteboard before push settled"));
    }
    return YES;
  } @finally {
    [pasteboard releaseGlobally];
  }
}

// -[SimDevice pasteboard] — the older, synchronous, in-process pasteboard API (see CLAUDE.md).
id LegacyPasteboardAccessor(id device) {
  return SafeInvoke([&] {
    using Fn = id (*)(id, SEL);
    return ((Fn)objc_msgSend)(device, NSSelectorFromString(@"pasteboard"));
  });
}

NSString* PullPasteboardStringLegacy(id device, NSError** error) {
  id pasteboard = LegacyPasteboardAccessor(device);
  NSError* itemsError = nil;
  NSArray* items = SafeInvoke([&] {
    using Fn = NSArray* (*)(id, SEL, NSArray*, NSError**);
    return ((Fn)objc_msgSend)(pasteboard, NSSelectorFromString(@"itemsFromPasteboardWithTypes:error:"),
                              @[ kPlainTextUTI ], &itemsError);
  });
  if (items == nil) {
    throw NSErrorException(itemsError ?: MakeError(4, @"Failed to read the device's pasteboard"));
  }
  if (items.count == 0) {
    return @"";
  }
  id value = SafeInvoke([&] {
    using Fn = id (*)(id, SEL, NSString*);
    return ((Fn)objc_msgSend)(items.firstObject, NSSelectorFromString(@"valueForType:"), kPlainTextUTI);
  });
  // Text flavours may come back as NSString or NSData of UTF-8 bytes.
  if ([value isKindOfClass:[NSData class]]) {
    return [[NSString alloc] initWithData:value encoding:NSUTF8StringEncoding] ?: @"";
  }
  return [value isKindOfClass:[NSString class]] ? value : @"";
}

BOOL PushPasteboardStringLegacy(id device, NSString* content, NSError** error) {
  id pasteboard = LegacyPasteboardAccessor(device);
  Class itemClass = RequireClass("SimPasteboardItem");
  // Plain alloc/init, both literal selectors the compiler resolves and ARC-balances itself — no
  // raw dispatch (and its ownership pitfalls, see ConnectPasteboardInterface) needed here.
  id item = SafeInvoke([&] { return [[itemClass alloc] init]; });
  BOOL valueSet = SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, id, NSString*);
    return ((Fn)objc_msgSend)(item, NSSelectorFromString(@"setValue:forType:"), content, kPlainTextUTI);
  });
  if (!valueSet) {
    throw NSErrorException(MakeError(5, @"Failed to prepare a pasteboard item for the device's pasteboard"));
  }
  NSError* setError = nil;
  SafeInvoke([&] {
    using Fn = unsigned long long (*)(id, SEL, NSArray*, NSError**);
    return ((Fn)objc_msgSend)(pasteboard, NSSelectorFromString(@"setPasteboardWithItems:error:"), @[ item ], &setError);
  });
  if (setError != nil) {
    throw NSErrorException(setError);
  }
  return YES;
}

}  // namespace

// Needs no special entitlement, unlike CoreDevice.framework's Mach services — confirmed
// empirically with an unsigned, unentitled probe (see git history). Prefers the modern
// SimPasteboardPlus mechanism when available, falling back to the legacy SimDevicePasteboard API
// (see ModernPasteboardAvailable above for why that choice isn't simply an Xcode-version check).
NSString* PullPasteboardString(id device, NSError** error) {
  return ModernPasteboardAvailable() ? PullPasteboardStringModern(device, error)
                                     : PullPasteboardStringLegacy(device, error);
}

BOOL PushPasteboardString(id device, NSString* content, NSError** error) {
  return ModernPasteboardAvailable() ? PushPasteboardStringModern(device, content, error)
                                     : PushPasteboardStringLegacy(device, content, error);
}

}  // namespace coresim
