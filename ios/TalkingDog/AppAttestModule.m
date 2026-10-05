#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(AppAttestModule, NSObject)

RCT_EXTERN_METHOD(
  generateKey:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  attestKey:(NSString *)keyId
  challengeB64:(NSString *)challengeB64
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  generateAssertion:(NSString *)keyId
  requestBodyJSON:(NSString *)requestBodyJSON
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

@end
