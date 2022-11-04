import { expect } from "chai";
import { BigNumber, Contract, utils } from "ethers";
import hre, { ethers } from "hardhat";

const gardenHolder = "0x5b0F8D8f47E3fDF7eE1c337AbCA19dBba98524e6";
const gardenVoters = [
  "0x6120f29ccb5b1DDaa5a747235F257Ef6cB47970F",
  "0xc89000E12C600b12D6e61a535cD3fedd4ac1eeC4",
  "0xa328500Eab25698b8b146D195F35f5b26C93AAEe",
];
const somebodyElse = "0x02d9cc72Bc796D2128E58c04B6e50A4E101c0be1";

const hny = "0x71850b7E9Ee3f13Ab46d67167341E4bDc905Eef9";
const retroactiveFundingMultisig = "0xe6a1b6B98dc978888b0c83DbA2D5fabcF5069312";
const commonPool = "0x4ba7362F9189572CbB1216819a45aba0d0B2D1CB";

describe.only("Test Conviction Voting Update", () => {
  it("return funds to common pool and executes the vote #14", async () => {
    // Return common pool funds
    const multisig = await impersonateAddress(retroactiveFundingMultisig);
    const token = new Contract(
      hny,
      [
        "function transfer(address,uint256) external returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ],
      multisig,
    );

    const multisigBalance = await token.balanceOf(retroactiveFundingMultisig);
    await (await token.transfer(commonPool, multisigBalance)).wait();

    expect(await token.balanceOf(commonPool)).to.be.greaterThan(BigNumber.from(10).pow(18).mul(8000));

    // Execute vote #14
    const signer = await impersonateAddress(gardenHolder);
    const voting = new Contract(
      "0xfbd0b2726070a9d6aff6d7216c9e9340eae68b2a",
      [
        "function vote(uint256 _voteId, bool _supports) external",
        "function executeVote(uint256 _voteId, bytes _executionScript) external",
      ],
      signer,
    );

    const voteId = 14;
    const executionScript =
      "0x000000010b21081c6f8b1990f53fc76279cc41ba22d7afe200000084c35ac76d00000000000000000000000000000000000000000000000000000000009895b700000000000000000000000000000000000000000000000000000000001e8480000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000002c68af0bb140000";

    for (const gardenVoter of gardenVoters) {
      await voting.connect(await impersonateAddress(gardenVoter)).vote(voteId, true, { gasLimit: 10_000_000 });
    }
    await mine((30 * 24 * 60 * 60) / 5, 5);
    await (await voting.executeVote(voteId, executionScript)).wait();
  });

  it("new conviction settings are correct", async () => {
    const signer = await impersonateAddress(gardenHolder);
    const conviction = new Contract(
      "0x0b21081c6f8b1990f53fc76279cc41ba22d7afe2",
      [
        "function decay() view returns (uint256)",
        "function maxRatio() view returns (uint256)",
        "function minThresholdStakePercentage() view returns (uint256)",
        "function weight() view returns (uint256)",
      ],
      signer,
    );

    expect(await conviction.decay()).to.equal(9999799);
    expect(await conviction.maxRatio()).to.equal(2000000);
    expect(await conviction.weight()).to.equal(10000);
    expect((await conviction.minThresholdStakePercentage()).toString()).to.equal("200000000000000000");
  });

  it("do not allow to execute a proposal with more than 20% of common pool tokens", async () => {
    const signer = await impersonateAddress(gardenHolder);
    const conviction = new Contract(
      "0x0b21081c6f8b1990f53fc76279cc41ba22d7afe2",
      ["function calculateThreshold(uint256 _requestedAmount) view returns (uint256 _threshold)"],
      signer,
    );

    await expect(conviction.calculateThreshold(BigNumber.from(10).pow(18).mul(2000))).to.be.revertedWith(
      "CV_AMOUNT_OVER_MAX_RATIO",
    );
  });

  it("allow to pass a proposal after enough time", async () => {
    const signer = await impersonateAddress(gardenHolder);
    const conviction = new Contract(
      "0x0b21081c6f8b1990f53fc76279cc41ba22d7afe2",
      [
        "function proposalCounter() view returns (uint256)",
        "function addProposal(string _title, bytes _link, uint256 _requestedAmount, bool _stableRequestAmount, address _beneficiary)",
        "function stakeToProposal(uint256 _proposalId, uint256 _amount)",
        "function executeProposal(uint256 _proposalId)",
        "event ProposalExecuted(uint256 indexed id, uint256 conviction)",
        "function getProposal(uint256 _proposalId) external view returns (uint256 requestedAmount, bool stableRequestAmount, address beneficiary, uint256 stakedTokens, uint256 convictionLast, uint64 blockLast, uint256 agreementActionId, uint8 proposalStatus, address submitter, uint256 threshold)",
      ],
      signer,
    );

    const proposalId = await conviction.proposalCounter();
    await (
      await conviction.addProposal("Test proposal", "0x", BigNumber.from(10).pow(18).mul(50), false, somebodyElse)
    ).wait();

    for (const gardenVoter of gardenVoters) {
      await conviction
        .connect(await impersonateAddress(gardenVoter))
        .stakeToProposal(proposalId, BigNumber.from(10).pow(18).mul(400), { gasLimit: 10_000_000 });
    }

    await mine((30 * 24 * 60 * 60) / 5, 5); // 30 days

    await expect(conviction.executeProposal(proposalId, { gasLimit: 10_000_000 })).to.emit(
      conviction,
      "ProposalExecuted",
    );
  });

  it("do not allow to pass a proposal quickly", async () => {
    const signer = await impersonateAddress(gardenHolder);
    const conviction = new Contract(
      "0x0b21081c6f8b1990f53fc76279cc41ba22d7afe2",
      [
        "function proposalCounter() view returns (uint256)",
        "function addProposal(string _title, bytes _link, uint256 _requestedAmount, bool _stableRequestAmount, address _beneficiary)",
        "function stakeToProposal(uint256 _proposalId, uint256 _amount)",
        "function executeProposal(uint256 _proposalId)",
      ],
      signer,
    );

    const proposalId = await conviction.proposalCounter();
    await (
      await conviction.addProposal("Test proposal", "0x", BigNumber.from(10).pow(18).mul(300), false, somebodyElse)
    ).wait();

    for (const gardenVoter of gardenVoters) {
      await conviction
        .connect(await impersonateAddress(gardenVoter))
        .stakeToProposal(proposalId, BigNumber.from(10).pow(18).mul(300), { gasLimit: 10_000_000 });
    }

    await mine((10 * 60) / 5, 5); // 10 minutes
    await expect(conviction.executeProposal(proposalId)).to.be.revertedWith("CV_INSUFFICIENT_CONVICION");
  });
});

export const impersonateAddress = async (address: string) => {
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });

  const signer = await ethers.provider.getSigner(address);

  return signer;
};

export const mine = async (blocks: number, interval: number) => {
  await hre.network.provider.send("hardhat_mine", [
    utils.hexlify(blocks).replace("0x0", "0x"),
    utils.hexlify(interval).replace("0x0", "0x"),
  ]);
};

export const increase = async (duration: string | BigNumber) => {
  if (!ethers.BigNumber.isBigNumber(duration)) {
    duration = ethers.BigNumber.from(duration);
  }

  if (duration.isNegative()) throw Error(`Cannot increase time by a negative amount (${duration})`);

  await hre.network.provider.request({
    method: "evm_increaseTime",
    params: [duration.toNumber()],
  });

  await hre.network.provider.request({
    method: "evm_mine",
  });
};
