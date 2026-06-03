import '@ton/test-utils';

import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, internal, SendMode, storeMessageRelaxed, toNano, Transaction } from '@ton/core';
import { MfaExtension, OpCode, prepareBodyWithoutSignature, prepareSeedAuthBody } from '../wrappers/MfaExtension';
import { compile } from '@ton/blueprint';
import { WalletContractV5R1 } from '@ton/ton';
import { getSecureRandomBytes, KeyPair, keyPairFromSeed, sign } from '@ton/crypto';
import { formatCoinsPure } from '@ton/sandbox/dist/utils/printTransactionFees';

const sharedSeed = Buffer.from('ZPR3kjVuq52XSUuoh/7YNpuUOWxRioFWe5Wnt1oSTZY=', 'base64');

const removalReqSigned = {
    authDate: 1780527990,
    signature: Buffer.from(
        'bUTicG1vV590agLi1BjmG0ys32FX83z9KZgX8iI4M-G8V3mXjQ1Sh83oJEPKOUr8vM_ylK5qnr9rhrgsRyjQBg',
        'base64',
    ),
};

const sendActionsSigned = {
    authDate: 1780527991,
    signature: Buffer.from(
        'zZgwZVxeut5FpfEul0gQZGxtd6VBx0BQGLLCrRFLNzOCxGy3JkR7_nBBP8eke6-fCW0GowhGJQsh1h6IcWFcAg',
        'base64',
    ),
};

const INVALID_SIGNATURE = Buffer.from(
    'Z7JC31npc4KbVwqmFykj_VaXZJeUCovoH-3X6AKMI6_X4arYNK_prNPVSABJy3ORoHUmi53b-VRHkd_GBN00ZZ',
    'base64',
);
const VALID_TELEGRAM_ID = "1368727604";

describe('MfaExtension', () => {
    let code: Cell;

    beforeAll(async () => {
        code = await compile('MfaExtension');
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let mfaExtension: SandboxContract<MfaExtension>;
    let walletV5: SandboxContract<WalletContractV5R1>;

    let sharedKeypair: KeyPair;

    let firstInstall = true;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = removalReqSigned.authDate - 30;

        deployer = await blockchain.treasury('deployer');

        sharedKeypair = keyPairFromSeed(sharedSeed);

        walletV5 = blockchain.openContract(
            WalletContractV5R1.create({
                publicKey: sharedKeypair.publicKey,
            }),
        );

        mfaExtension = blockchain.openContract(
            MfaExtension.createFromConfig(
                {
                    walletAddress: walletV5.address,
                    telegramId: VALID_TELEGRAM_ID,
                    seedPubkey: sharedKeypair.publicKey,
                },
                code,
            ),
        );

        await deployer.send({
            value: toNano('1000'),
            to: walletV5.address,
            bounce: false,
        });

        await walletV5.sendAddExtension({
            authType: 'external',
            seqno: await walletV5.getSeqno(),
            secretKey: sharedKeypair.secretKey,
            extensionAddress: mfaExtension.address,
        });

        const sender = (await walletV5.sender(sharedKeypair.secretKey)).result;
        const result = await mfaExtension.sendDeploy(sender, toNano('5'));

        if (firstInstall) {
            console.log('=== INSTALL EXTENSION ===');
            printGasUsage(result.transactions);
            firstInstall = false;
        }

        expect(result.transactions).toHaveTransaction({
            from: walletV5.address,
            to: mfaExtension.address,
            deploy: true,
            success: true,
        });

        expect(await walletV5.getIsSecretKeyAuthEnabled()).toEqual(false);
    });

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and mfaExtension are ready to use
    });

    const getTestMessage = async (): Promise<Cell> => {
        const msg = internal({
            to: walletV5.address,
            value: toNano('1'),
            body: walletV5.createRequest({
                authType: 'extension',
                seqno: await walletV5.getSeqno(),
                actions: [
                    {
                        type: 'sendMsg',
                        mode: SendMode.PAY_GAS_SEPARATELY,
                        outMsg: internal({
                            to: deployer.address,
                            value: toNano('0.1'),
                        }),
                    },
                ],
            }),
        });

        return beginCell()
            .storeUint(SendMode.IGNORE_ERRORS, 8)
            .storeRef(beginCell().store(storeMessageRelaxed(msg)).endCell())
            .endCell();
    };

    describe('remove extension', () => {
        it('should destruct', async () => {
            const opts = {
                telegramId: VALID_TELEGRAM_ID,
                seqno: await mfaExtension.getSeqno(),
                opCode: OpCode.REMOVE_EXTENSION,
                payload: beginCell().endCell(),
                authDate: removalReqSigned.authDate,
            };

            const payloadHash = prepareBodyWithoutSignature(opts).hash();
            console.log('Remove extension Msg hash', payloadHash.toString('base64'));

            const seedSignature = sign(payloadHash, sharedKeypair.secretKey);

            const res = await mfaExtension.sendRemoveExtension({
                ...opts,
                signature: removalReqSigned.signature,
                seedSignature,
            });

            console.log('==== REMOVE EXTENSION ====');
            printGasUsage(res.transactions);

            expect(res.transactions).toHaveTransaction({
                to: mfaExtension.address,
                success: true,
            });

            expect(res.transactions).toHaveTransaction({
                from: mfaExtension.address,
                to: walletV5.address,
                success: true,
                exitCode: 0,
            });

            expect(await walletV5.getIsSecretKeyAuthEnabled()).toEqual(true);
            expect(await walletV5.getExtensionsArray()).toEqual([]);

            const accountState = await blockchain.getContract(mfaExtension.address);
            expect(accountState.accountState).toEqual(undefined);
        });

        it('should`t destruct due to invalid telegram signature', async () => {
            const opts = {
                authDate: removalReqSigned.authDate,
                telegramId: VALID_TELEGRAM_ID,
                seqno: await mfaExtension.getSeqno(),
            };

            const bodyHash = prepareBodyWithoutSignature({
                ...opts,
                opCode: OpCode.REMOVE_EXTENSION,
                payload: beginCell().endCell(),
            }).hash();
            const seedSignature = sign(bodyHash, sharedKeypair.secretKey);

            try {
                await mfaExtension.sendRemoveExtension({ ...opts, signature: INVALID_SIGNATURE, seedSignature });

                expect(true).toBe(false);
            } catch (e: any) {
                expect(e.message).toContain('702');
            }
        });

        it('should`t destruct due to invalid seed signature', async () => {
            const opts = {
                authDate: removalReqSigned.authDate,
                telegramId: VALID_TELEGRAM_ID,
                seqno: await mfaExtension.getSeqno(),
            };

            const bodyHash = prepareBodyWithoutSignature({
                ...opts,
                opCode: OpCode.REMOVE_EXTENSION,
                payload: beginCell().endCell(),
            }).hash();
            const seedSignature = sign(bodyHash, (await randomKeypair()).secretKey);

            try {
                await mfaExtension.sendRemoveExtension({
                    ...opts,
                    signature: removalReqSigned.signature,
                    seedSignature,
                });

                expect(true).toBe(false);
            } catch (e: any) {
                expect(e.message).toContain('702');
            }
        });
    });

    describe('send actions', () => {
        it('should send actions', async () => {
            const opts = {
                authDate: sendActionsSigned.authDate,
                telegramId: VALID_TELEGRAM_ID,
                payload: await getTestMessage(),
                seqno: await mfaExtension.getSeqno(),
            };

            const bodyHash = prepareBodyWithoutSignature({ ...opts, opCode: OpCode.SEND_ACTIONS }).hash();
            const seedSignature = sign(bodyHash, sharedKeypair.secretKey);

            console.log('Send Actions Msg hash:', bodyHash.toString('base64'));

            const res = await mfaExtension.sendSendActions({
                ...opts,
                signature: sendActionsSigned.signature,
                seedSignature,
            });

            expect(res.transactions).toHaveTransaction({
                from: walletV5.address,
                to: deployer.address,
                value: toNano('0.1'),
            });

            printGasUsage(res.transactions);
        });

        it('should send actions via internal message', async () => {
            const opts = {
                authDate: sendActionsSigned.authDate,
                telegramId: VALID_TELEGRAM_ID,
                payload: await getTestMessage(),
                seqno: await mfaExtension.getSeqno(),
            };

            const bodyHash = prepareBodyWithoutSignature({ ...opts, opCode: OpCode.SEND_ACTIONS }).hash();
            const seedSignature = sign(bodyHash, sharedKeypair.secretKey);

            const res = await mfaExtension.sendActionsInternal(deployer.getSender(), toNano('0.15'), {
                ...opts,
                signature: sendActionsSigned.signature,
                seedSignature,
            });

            expect(res.transactions).toHaveTransaction({
                from: walletV5.address,
                to: deployer.address,
                value: toNano('0.1'),
            });
        });

        it('should`t send actions due to invalid telegram signature', async () => {
            const opts = {
                authDate: sendActionsSigned.authDate,
                telegramId: VALID_TELEGRAM_ID,
                payload: await getTestMessage(),
                seqno: await mfaExtension.getSeqno(),
            };

            const bodyHash = prepareBodyWithoutSignature({ ...opts, opCode: OpCode.SEND_ACTIONS }).hash();
            const seedSignature = sign(bodyHash, sharedKeypair.secretKey);

            const res = await mfaExtension.sendActionsInternal(deployer.getSender(), toNano('0.15'), {
                ...opts,
                signature: INVALID_SIGNATURE,
                seedSignature,
            });

            expect(res.transactions).toHaveTransaction({
                exitCode: 702,
            });
        });

        it('should`t send actions due to invalid seed signature', async () => {
            const opts = {
                authDate: sendActionsSigned.authDate,
                telegramId: VALID_TELEGRAM_ID,
                payload: await getTestMessage(),
                seqno: await mfaExtension.getSeqno(),
            };

            const bodyHash = prepareBodyWithoutSignature({ ...opts, opCode: OpCode.SEND_ACTIONS }).hash();
            const seedSignature = sign(bodyHash, (await randomKeypair()).secretKey);

            const res = await mfaExtension.sendActionsInternal(deployer.getSender(), toNano('0.15'), {
                ...opts,
                signature: sendActionsSigned.signature,
                seedSignature,
            });

            expect(res.transactions).toHaveTransaction({
                exitCode: 702,
            });
        });
    });

    describe('recovery', () => {
        const getValidRequest = (opCode: number, seqno: number = 1, now?: number) => {
            const validUntil = (now ?? Math.round(Date.now() / 1000)) + 60 * 5;
            const payload = { validUntil, seqno };
            const bodyHash = prepareSeedAuthBody(opCode, payload).endCell().hash();
            const signature = sign(bodyHash, sharedKeypair.secretKey);

            return {
                ...payload,
                signature,
            };
        };

        it('should be able to recover the wallet', async () => {
            let mfaState = await mfaExtension.getRecoveryState();
            expect(mfaState.isRecoveryStarted).toBe(false);

            await mfaExtension.sendRecovery(getValidRequest(OpCode.RECOVERY));
            mfaState = await mfaExtension.getRecoveryState();
            expect(mfaState.isRecoveryStarted).toBe(true);

            blockchain.now = blockchain.now! + 60 * 60 * 24 * 14 + 1;

            const res = await mfaExtension.sendRecovery(getValidRequest(OpCode.RECOVERY, 2, blockchain.now));

            // extension must be deleted

            expect(res.transactions).toHaveTransaction({
                to: mfaExtension.address,
                success: true,
            });

            expect(res.transactions).toHaveTransaction({
                from: mfaExtension.address,
                to: walletV5.address,
                success: true,
                exitCode: 0,
            });

            expect(await walletV5.getIsSecretKeyAuthEnabled()).toEqual(true);
            expect(await walletV5.getExtensionsArray()).toEqual([]);

            const accountState = await blockchain.getContract(mfaExtension.address);
            expect(accountState.accountState).toEqual(undefined);
        });

        it('should be able to cancel recovery', async () => {
            let mfaState = await mfaExtension.getRecoveryState();
            expect(mfaState.isRecoveryStarted).toBe(false);

            await mfaExtension.sendRecovery(getValidRequest(OpCode.RECOVERY));
            mfaState = await mfaExtension.getRecoveryState();
            expect(mfaState.isRecoveryStarted).toBe(true);

            await mfaExtension.sendCancelRecovery(getValidRequest(OpCode.CANCEL_RECOVERY, 2));
            mfaState = await mfaExtension.getRecoveryState();
            expect(mfaState.isRecoveryStarted).toBe(false);
            expect(mfaState.blockedUntil).toBeCloseTo(blockchain.now! + 60 * 60 * 24);
        });

        it('should`t allow wallet recovery before 14 days', async () => {
            let mfaState = await mfaExtension.getRecoveryState();
            expect(mfaState.isRecoveryStarted).toBe(false);

            await mfaExtension.sendRecovery(getValidRequest(OpCode.RECOVERY));
            mfaState = await mfaExtension.getRecoveryState();
            expect(mfaState.isRecoveryStarted).toBe(true);

            try {
                await mfaExtension.sendRecovery(getValidRequest(OpCode.RECOVERY, 2, blockchain.now));
                expect(true).toBe(false);
            } catch (err: any) {
                expect(err.message).toContain('code 710');
            }
        });

        it('should`t allow wallet recovery due to invalid seed signature', async () => {
            const keyPair = await randomKeypair();
            const validUntil = Math.round(Date.now() / 1000) + 60 * 5;
            const payload = { validUntil, seqno: 1 };
            const bodyHash = prepareSeedAuthBody(OpCode.RECOVERY, payload).endCell().hash();
            const signature = sign(bodyHash, keyPair.secretKey);

            try {
                await mfaExtension.sendRecovery({ ...payload, signature });
                expect(true).toBe(false);
            } catch (err: any) {
                expect(err.message).toContain('code 702');
            }
        });

        it('should`t allow cancel wallet recovery due to invalid seed signature', async () => {
            const keyPair = await randomKeypair();
            const validUntil = Math.round(Date.now() / 1000) + 60 * 5;
            const payload = { validUntil, seqno: 1 };
            const bodyHash = prepareSeedAuthBody(OpCode.CANCEL_RECOVERY, payload).endCell().hash();
            const signature = sign(bodyHash, keyPair.secretKey);

            try {
                await mfaExtension.sendCancelRecovery({ ...payload, signature });
                expect(true).toBe(false);
            } catch (err: any) {
                expect(err.message).toContain('code 702');
            }
        });

        it('should`t allow send actions while recovery in progress', async () => {
            await mfaExtension.sendRecovery(getValidRequest(OpCode.RECOVERY));
            const mfaState = await mfaExtension.getRecoveryState();
            expect(mfaState.isRecoveryStarted).toBe(true);

            const opts = {
                payload: await getTestMessage(),
                seqno: await mfaExtension.getSeqno(),
            };

            const bodyHash = prepareBodyWithoutSignature({ ...opts, opCode: OpCode.SEND_ACTIONS }).hash();
            const seedSignature = sign(bodyHash, sharedKeypair.secretKey);

            try {
                await mfaExtension.sendSendActions({
                    ...opts,
                    signature: sendActionsSigned.signature,
                    authDate: sendActionsSigned.authDate,
                    seedSignature,
                });
                expect(true).toBe(false);
            } catch (err: any) {
                expect(err.message).toContain('code 705');
            }
        });
    });
});

async function randomKeypair() {
    return keyPairFromSeed(await getSecureRandomBytes(32));
}

function formatCoins(value?: bigint, precision = 6) {
    if (value === undefined) return 'N/A';
    return formatCoinsPure(value, precision) + ' TON';
}

function printGasUsage(transactions: Transaction[]) {
    console.table(
        transactions.map((tx) => {
            if (tx.description.type !== 'generic') return undefined;

            const body = tx.inMessage?.info.type === 'internal' ? tx.inMessage?.body.beginParse() : undefined;
            const op = body === undefined ? undefined : body.remainingBits >= 32 ? body.preloadUint(32) : undefined;

            const computeGasUsed =
                tx.description.computePhase.type === 'vm' ? tx.description.computePhase.gasUsed : undefined;
            const valueIn = formatCoins(
                tx.inMessage?.info.type === 'internal' ? tx.inMessage.info.value.coins : undefined,
            );
            const valueOut = formatCoins(
                tx.outMessages
                    .values()
                    .reduce(
                        (total, message) => total + (message.info.type === 'internal' ? message.info.value.coins : 0n),
                        0n,
                    ),
            );

            return {
                op: op ? `0x${op.toString(16)}` : 'N/A',
                valueIn,
                valueOut,
                outActions: tx.description.actionPhase?.totalActions ?? 'N/A',
                computeGasUsed,
                exitCode: tx.description.computePhase.type === 'vm' ? tx.description.computePhase.exitCode : 'N/A',
                actionCode: tx.description.actionPhase?.resultCode ?? 'N/A',
            };
        }),
    );
}
