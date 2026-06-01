import { compile, NetworkProvider } from '@ton/blueprint';
import { LibraryDeployer } from '../wrappers/LibDeployer';
import { toNano } from '@ton/core';

export async function run(provider: NetworkProvider) {
  const libraryDeployer = provider.open(
    LibraryDeployer.createFromConfig(
        { libraryCode: await compile('MfaExtension') },
        await compile('LibDeployer')
    )
  );

  await libraryDeployer.sendDeploy(provider.sender(), toNano('0.1'));
  await provider.waitForDeploy(libraryDeployer.address);

  console.log('LIBRARY ADDRESS', libraryDeployer.address);
}