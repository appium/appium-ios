import chai from 'chai';
import InstallationServiceProxy from '../../lib/installation-proxy';
import PlistService from '../../lib/plist-service';
import { getServerWithFixtures, fixtures } from '../fixtures';


chai.should();

describe('installation proxy', function () {
  let server;
  let socket;
  let installationServiceProxy;

  afterEach(function (done) {
    if (installationServiceProxy) {
      installationServiceProxy.close();
    }
    server.stop(done);
  });

  it('should get a list of installed applications', async function () {
    ({server, socket} = await getServerWithFixtures(fixtures.INSTALLATION_PROXY_LIST_MESSAGE));
    installationServiceProxy = new InstallationServiceProxy(new PlistService(socket));
    const appMap = await installationServiceProxy.listApplications();
    appMap.should.have.property('com.apple.test.WebDriverAgentRunner-Runner');
  });

  it('should install an application successfully', async function () {
    ({server, socket} = await getServerWithFixtures(fixtures.INSTALLATION_PROXY_INSTALL_MESSAGE));
    installationServiceProxy = new InstallationServiceProxy(new PlistService(socket));
    await installationServiceProxy.installApplication('PublicStaging/app.ipa');
  });
});
