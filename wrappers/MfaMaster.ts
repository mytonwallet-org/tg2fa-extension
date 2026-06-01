import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from "@ton/core";

export class MfaMaster implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell },
  ) {}

  static createFromAddress(address: Address) {
    return new MfaMaster(address);
  }

  static createFromConfig(code: Cell, workchain = 0) {
    const data = beginCell().endCell();
    const init = { code, data };
    return new MfaMaster(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
    });
  }

  async getEstimatedFee(provider: ContractProvider, opts: { forwardMsg: Cell, actions: number; extendedActions: number }) {
    const { stack } = await provider.get('get_estimated_fees_on_send_actions', [
      { type: 'cell', cell: opts.forwardMsg },
      { type: 'int', value: BigInt(opts.actions) },
      { type: 'int', value: BigInt(opts.extendedActions) }
    ]);

    return stack.readBigNumber();
  }
}
