
import { compile, NetworkProvider } from '@ton/blueprint';
import { LibraryDeployer } from '../wrappers/LibDeployer';
import { toNano } from '@ton/core';
import { MfaMaster } from '../wrappers/MfaMaster';

export async function run(provider: NetworkProvider) {
  const mfaMaster = provider.open(
    MfaMaster.createFromConfig(await compile('MfaMaster'))
  );

  await mfaMaster.sendDeploy(provider.sender(), toNano('0.1'));
  await provider.waitForDeploy(mfaMaster.address);

  console.log('Address', mfaMaster.address)
}