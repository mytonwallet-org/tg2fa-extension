import { toNano } from '@ton/core';
import { MfaExtension } from '../wrappers/MfaExtension';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const telegramId = Number(await provider.ui().input('Telegram Id'));
    const walletAddress = await provider.ui().inputAddress('Wallet Address');

    const mfaExtension = provider.open(
        MfaExtension.createFromConfig(
            {
                telegramId,
                walletAddress,
            },
            await compile('MfaExtension'),
        ),
    );

    await mfaExtension.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(mfaExtension.address);

    // run methods on `mfaExtension`
}
