#import <UIKit/UIKit.h>

@interface PortraitController : UIViewController
@end

@implementation PortraitController
- (void)viewDidLoad
{
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.systemTealColor;
  for (NSInteger index = 1; index <= 3; index++) {
    UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
    button.tag = index;
    button.accessibilityIdentifier = [NSString stringWithFormat:@"portrait-counter-%ld", (long)index];
    [button setTitle:@"0" forState:UIControlStateNormal];
    button.backgroundColor = UIColor.whiteColor;
    [button addTarget:self action:@selector(tapped:) forControlEvents:UIControlEventTouchUpInside];
    [self.view addSubview:button];
  }
}

- (void)viewDidLayoutSubviews
{
  [super viewDidLayoutSubviews];
  // Fixed fractions give the test viewport targets independent of AX geometry.
  for (UIButton *button in self.view.subviews) {
    button.frame = CGRectMake(CGRectGetMidX(self.view.bounds) - 60,
                              self.view.bounds.size.height * button.tag / 4.0 - 25, 120, 50);
  }
}

- (void)tapped:(UIButton *)button
{
  [button setTitle:[NSString stringWithFormat:@"%ld", (long)button.currentTitle.integerValue + 1]
         forState:UIControlStateNormal];
}
@end

@interface PortraitDelegate : UIResponder <UIApplicationDelegate, UIWindowSceneDelegate>
@property (nonatomic) UIWindow *window;
@end

@implementation PortraitDelegate
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session
      options:(UISceneConnectionOptions *)options
{
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [PortraitController new];
  [self.window makeKeyAndVisible];
}
@end

int main(int argc, char **argv)
{
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(PortraitDelegate.class));
  }
}
