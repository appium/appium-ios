#import <UIKit/UIKit.h>

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@property (nonatomic) NSInteger touchCount;
@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options
{
  // Use the pre-scene lifecycle so Duo hosts this app in a compatibility window.
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  UIViewController *controller = [UIViewController new];
  controller.view.backgroundColor = UIColor.whiteColor;
  UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
  button.accessibilityIdentifier = @"touch-counter";
  [button setTitle:@"0" forState:UIControlStateNormal];
  [button addTarget:self action:@selector(tapped:) forControlEvents:UIControlEventTouchUpInside];
  button.translatesAutoresizingMaskIntoConstraints = NO;
  [controller.view addSubview:button];
  [NSLayoutConstraint activateConstraints:@[
    [button.centerXAnchor constraintEqualToAnchor:controller.view.centerXAnchor],
    [button.centerYAnchor constraintEqualToAnchor:controller.view.centerYAnchor],
    [button.widthAnchor constraintEqualToConstant:140],
    [button.heightAnchor constraintEqualToConstant:80],
  ]];
  self.window.rootViewController = controller;
  [self.window makeKeyAndVisible];
  return YES;
}

- (void)tapped:(UIButton *)button
{
  self.touchCount++;
  [button setTitle:@(self.touchCount).stringValue forState:UIControlStateNormal];
}

@end

int main(int argc, char **argv)
{
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(AppDelegate.class));
  }
}
