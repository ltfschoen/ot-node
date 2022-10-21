import Web3 from 'web3';
import axios from 'axios';
import { peerId2Hash } from 'assertion-tools';
import { createRequire } from 'module';
import { INIT_STAKE_AMOUNT, WEBSOCKET_PROVIDER_OPTIONS } from '../../../constants/constants.js';

const require = createRequire(import.meta.url);
const Hub = require('dkg-evm-module/build/contracts/Hub.json');
const AssetRegistry = require('dkg-evm-module/build/contracts/AssetRegistry.json');
const ERC20Token = require('dkg-evm-module/build/contracts/ERC20Token.json');
const Identity = require('dkg-evm-module/build/contracts/Identity.json');
const Profile = require('dkg-evm-module/build/contracts/Profile.json');
const ProfileStorage = require('dkg-evm-module/build/contracts/ProfileStorage.json');
const ShardingTable = require('dkg-evm-module/build/contracts/ShardingTable.json');

class Web3Service {
    async initialize(config, logger) {
        this.config = config;
        this.logger = logger;
        // this.eventEmitter = ctx.eventEmitter;

        this.rpcNumber = 0;
        await this.initializeWeb3();
        await this.initializeContracts();
    }

    async initializeWeb3() {
        let tries = 0;
        let isRpcConnected = false;
        while (!isRpcConnected) {
            if (tries >= this.config.rpcEndpoints.length) {
                throw Error('Blockchain initialisation failed');
            }

            try {
                if (this.config.rpcEndpoints[this.rpcNumber].startsWith('ws')) {
                    const provider = new Web3.providers.WebsocketProvider(
                        this.config.rpcEndpoints[this.rpcNumber],
                        WEBSOCKET_PROVIDER_OPTIONS,
                    );
                    this.web3 = new Web3(provider);
                } else {
                    this.web3 = new Web3(this.config.rpcEndpoints[this.rpcNumber]);
                }
                // eslint-disable-next-line no-await-in-loop
                isRpcConnected = await this.web3.eth.net.isListening();
            } catch (e) {
                this.logger.warn(
                    `Unable to connect to blockchain rpc : ${
                        this.config.rpcEndpoints[this.rpcNumber]
                    }.`,
                );
                tries += 1;
                this.rpcNumber = (this.rpcNumber + 1) % this.config.rpcEndpoints.length;
            }
        }
    }

    async initializeContracts() {
        // TODO encapsulate in a generic function
        this.logger.info(`Hub contract address is ${this.config.hubContractAddress}`);
        this.hubContract = new this.web3.eth.Contract(Hub.abi, this.config.hubContractAddress);

        const assetRegistryAddress = await this.callContractFunction(
            this.hubContract,
            'getContractAddress',
            ['AssetRegistry'],
        );
        this.AssetRegistryContract = new this.web3.eth.Contract(
            AssetRegistry.abi,
            assetRegistryAddress,
        );

        const tokenAddress = await this.callContractFunction(
            this.hubContract,
            'getContractAddress',
            ['Token'],
        );
        this.TokenContract = new this.web3.eth.Contract(ERC20Token.abi, tokenAddress);

        const profileAddress = await this.callContractFunction(
            this.hubContract,
            'getContractAddress',
            ['Profile'],
        );
        this.ProfileContract = new this.web3.eth.Contract(Profile.abi, profileAddress);

        const profileStorageAddress = await this.callContractFunction(
            this.hubContract,
            'getContractAddress',
            ['ProfileStorage'],
        );
        this.ProfileStorageContract = new this.web3.eth.Contract(
            ProfileStorage.abi,
            profileStorageAddress,
        );

        const shardingTableAddress = await this.callContractFunction(
            this.hubContract,
            'getContractAddress',
            ['ShardingTable'],
        );
        this.ShardingTableContract = new this.web3.eth.Contract(
            ShardingTable.abi,
            shardingTableAddress,
        );
        const shardingTable = new Map();
        shardingTable.set('QmU12cgaJpeaaU4xRC5n95r52AiFTqGdtCaEgnzn9ytpxu', [10000, 1]);
        shardingTable.set('QmXJ8AoFpUBnKHswyANnANmnE9T48xBq5geD4U9KjngKy3', [49000, 1]);
        shardingTable.set('QmajtBnsXmXqRC2oNhbcWqRgJ8o5prMr1Tscxnv11YHeo3', [31322, 1]);
        shardingTable.set('QmWx3AbppQLpo3N8HvXNVG93uVrzvhBq2HWMJBeu4QxhNy', [11230, 1]);
        shardingTable.set('QmYcMXMw2Uj71RraH4xezAaVFpisCY4FBZUSc1xEnBUWQK', [31000, 1]);
        shardingTable.set('QmXbMc3Kpyv5XL8hQvws8xgJwshsNz8PezxL8XCni12wXb', [15456, 1]);
        shardingTable.set('QmY3EptiY5Kr5nrB93DtAPgzhyhAjAi4jYHUiS2ynZowa7', [10000, 1]);
        shardingTable.set('QmciLYezwcEhJiCzqFZ7rTnjDgyYBQ7Tu3FwgFoKE6mzUu', [20000, 1]);
        shardingTable.set('QmRnyWLU5E7vWSZ1353gbfQ4zSXLLX97QA6dC9rKn2iNAy', [30000, 1]);
        shardingTable.set('QmYnwndBzaXWFzPWYazZPo46VC2DkMGdPvwfZTefNM4TZw', [40000, 1]);

        for (const [key, value] of shardingTable) {
            /* eslint-disable no-await-in-loop */
            await this.callContractFunction(this.ShardingTableContract, 'pushBack', [
                key,
                value[1],
                value[0],
            ]);
        }
        // ['PeerObjCreated', 'PeerParamsUpdated', 'PeerRemoved'].forEach((eventName) => {
        //     this.subscribeToContractEvent(this.ShardingTableContract, eventName);
        // });

        if (this.identityExists()) {
            this.identityContract = new this.web3.eth.Contract(Identity.abi, this.getIdentity());
        }

        this.logger.debug(
            `Connected to blockchain rpc : ${this.config.rpcEndpoints[this.rpcNumber]}.`,
        );

        await this.logBalances();
    }

    async logBalances() {
        const nativeBalance = await this.getNativeTokenBalance();
        const tokenBalance = await this.getTokenBalance();
        this.logger.info(
            `Balance of ${this.getPublicKey()} is ${nativeBalance} ${
                this.baseTokenTicker
            } and ${tokenBalance} ${this.tracTicker}.`,
        );
    }

    async getNativeTokenBalance() {
        const nativeBalance = await this.web3.eth.getBalance(this.getPublicKey());
        return this.web3.utils.fromWei(nativeBalance);
    }

    async getTokenBalance() {
        const tokenBalance = await this.callContractFunction(this.TokenContract, 'balanceOf', [
            this.getPublicKey(),
        ]);
        return this.web3.utils.fromWei(tokenBalance);
    }

    identityExists() {
        return this.config.identity != null;
    }

    getIdentity() {
        return this.config.identity;
    }

    getBlockNumber() {
        return this.web3.eth.getBlockNumber();
    }

    // TODO get from blockchain
    getBlockTime() {
        return this.config.blockTime;
    }

    async deployIdentity() {
        const transactionReceipt = await this.deployContract(Identity, [
            this.getPublicKey(),
            this.getManagementKey(),
        ]);
        this.config.identity = transactionReceipt.contractAddress;
    }

    async createProfile(peerId) {
        await this.executeContractFunction(this.TokenContract, 'increaseAllowance', [
            this.ProfileContract.options.address,
            INIT_STAKE_AMOUNT,
        ]);

        const nodeId = await peerId2Hash(peerId);

        await this.executeContractFunction(this.ProfileContract, 'createProfile', [
            this.getManagementKey(),
            nodeId,
            INIT_STAKE_AMOUNT,
            this.getIdentity(),
        ]);
    }

    getEpochs(UAI) {
        return this.callContractFunction(this.AssetRegistryContract, 'getEpochs', [UAI]);
    }

    async getChallenge(UAI, epoch) {
        return this.callContractFunction(this.AssetRegistryContract, 'getChallenge', [
            UAI,
            epoch,
            this.getIdentity(),
        ]);
    }

    async answerChallenge(UAI, epoch, proof, leaf, price) {
        return this.executeContractFunction(this.AssetRegistryContract, 'answerChallenge', [
            UAI,
            epoch,
            proof,
            leaf,
            price,
            this.getIdentity(),
        ]);
    }

    async getReward(UAI, epoch) {
        return this.executeContractFunction(this.AssetRegistryContract, 'getReward', [
            UAI,
            epoch,
            this.getIdentity(),
        ]);
    }

    getPrivateKey() {
        return this.config.evmOperationalWalletPrivateKey;
    }

    getPublicKey() {
        return this.config.evmOperationalWalletPublicKey;
    }

    getManagementKey() {
        return this.config.evmManagementWalletPublicKey;
    }

    async getGasPrice() {
        try {
            const response = await axios.get(this.config.gasPriceOracleLink);
            const gasPriceRounded = Math.round(response.data.standard.maxFee * 1e9);
            return gasPriceRounded;
        } catch (error) {
            return undefined;
        }
    }

    async callContractFunction(contractInstance, functionName, args) {
        let result;
        while (!result) {
            try {
                // eslint-disable-next-line no-await-in-loop
                result = await contractInstance.methods[functionName](...args).call();
            } catch (error) {
                // eslint-disable-next-line no-await-in-loop
                await this.handleError(error, functionName);
            }
        }

        return result;
    }

    async executeContractFunction(contractInstance, functionName, args) {
        let result;
        while (!result) {
            try {
                /* eslint-disable no-await-in-loop */
                const gasPrice = await this.getGasPrice();

                const gasLimit = await contractInstance.methods[functionName](...args).estimateGas({
                    from: this.getPublicKey(),
                });

                const encodedABI = contractInstance.methods[functionName](...args).encodeABI();
                const tx = {
                    from: this.getPublicKey(),
                    to: contractInstance.options.address,
                    data: encodedABI,
                    gasPrice: gasPrice || this.web3.utils.toWei('20', 'Gwei'),
                    gas: gasLimit || this.web3.utils.toWei('900', 'Kwei'),
                };

                const createdTransaction = await this.web3.eth.accounts.signTransaction(
                    tx,
                    this.getPrivateKey(),
                );
                result = await this.web3.eth.sendSignedTransaction(
                    createdTransaction.rawTransaction,
                );
            } catch (error) {
                await this.handleError(error, functionName);
            }
        }

        return result;
    }

    // async subscribeToContractEvent(contract, eventName) {
    //     contract.events[eventName](
    //         {
    //             fromBlock: 'pending', // block number to start listening from
    //         },
    //         () => {},
    //     )
    //         .on('connected', (subscriptionId) => {
    //             // fired after subscribing to an event
    //             this.logger.debug(
    //                 `Subscribed to '${eventName}' event. Subscription ID: '${subscriptionId}'`,
    //             );
    //         })
    //         .on('data', (event) => {
    //             // fired when we get a new log that matches the filters for the
    //             // event type we subscribed to will be fired at the same moment
    //             // as the callback above
    //             this.eventEmitter.emit(eventName, event.returnValues);
    //         })
    //         .on('changed', (event) => {
    //             // fired when the event is removed from the blockchain
    //             // (it adds this property on the event: removed = true
    //             this.logger.warn(
    //                 `Event '${eventName}' has been removed from the blockchain.
    //             Event: ${event}`,
    //             );
    //         })
    //         .on('error', (error, receipt) => {
    //             // fired if the subscribe transaction was rejected by the network
    //             // with a receipt, the second parameter will be the receipt.
    //             this.logger.error(
    //                 `Error: ${error}
    //             Receipt: ${receipt}`,
    //             );
    //         });
    // }

    async deployContract(contract, args) {
        let result;
        while (!result) {
            try {
                const contractInstance = new this.web3.eth.Contract(contract.abi);
                const gasPrice = await this.getGasPrice();

                const gasLimit = await contractInstance
                    .deploy({
                        data: contract.bytecode,
                        arguments: args,
                    })
                    .estimateGas({
                        from: this.getPublicKey(),
                    });

                const encodedABI = contractInstance
                    .deploy({
                        data: contract.bytecode,
                        arguments: args,
                    })
                    .encodeABI();

                const tx = {
                    from: this.getPublicKey(),
                    data: encodedABI,
                    gasPrice: gasPrice || this.web3.utils.toWei('20', 'Gwei'),
                    gas: gasLimit || this.web3.utils.toWei('900', 'Kwei'),
                };

                const createdTransaction = await this.web3.eth.accounts.signTransaction(
                    tx,
                    this.getPrivateKey(),
                );

                return this.web3.eth.sendSignedTransaction(createdTransaction.rawTransaction);
            } catch (error) {
                await this.handleError(error, 'deploy');
            }
        }

        return result;
    }

    async getLatestCommitHash(contract, tokenId) {
        try {
            return await this.callContractFunction(this.AssetRegistryContract, 'getCommitHash', [
                tokenId,
                0,
            ]);
        } catch (e) {
            this.logger.error(`Error on calling contract function. ${e}`);
            return false;
        }
    }

    async healthCheck() {
        try {
            const gasPrice = await this.web3.eth.getGasPrice();
            if (gasPrice) return true;
        } catch (e) {
            this.logger.error(`Error on checking blockchain. ${e}`);
            return false;
        }
        return false;
    }

    async handleError(error, functionName) {
        let isRpcError = false;
        try {
            await this.web3.eth.net.isListening();
        } catch (rpcError) {
            isRpcError = true;
            this.logger.warn(
                `Unable to execute smart contract function ${functionName} using blockchain rpc : ${
                    this.config.rpcEndpoints[this.rpcNumber]
                }.`,
            );
            await this.restartService();
        }
        if (!isRpcError) throw error;
    }

    async restartService() {
        this.rpcNumber = (this.rpcNumber + 1) % this.config.rpcEndpoints.length;
        this.logger.warn(
            `There was an issue with current blockchain rpc. Connecting to ${
                this.config.rpcEndpoints[this.rpcNumber]
            }`,
        );
        await this.initializeWeb3();
        await this.initializeContracts();
    }

    async getPeer(peerId) {
        try {
            return await this.callContractFunction(this.ShardingTableContract, 'getPeer', [peerId]);
        } catch (e) {
            this.logger.error(`Error on calling contract function. ${e}`);
            return false;
        }
    }

    async getShardingTablePage(startingPeerId, nodesNum) {
        try {
            return await this.callContractFunction(this.ShardingTableContract, 'getShardingTable', [
                startingPeerId,
                nodesNum,
            ]);
        } catch (e) {
            this.logger.error(`Error on calling contract function. ${e}`);
            return false;
        }
    }

    async getShardingTableFull() {
        try {
            return await this.callContractFunction(
                this.ShardingTableContract,
                'getShardingTable',
                [],
            );
        } catch (e) {
            this.logger.error(`Error on calling contract function. ${e}`);
            return false;
        }
    }

    async pushPeerBack(peerId, ask, stake) {
        try {
            return this.executeContractFunction(this.ShardingTableContract, 'pushBack', [
                peerId,
                ask,
                stake,
            ]);
        } catch (e) {
            this.logger.error(`Error on executing contract function. ${e}`);
            return false;
        }
    }

    async pushPeerFront(peerId, ask, stake) {
        try {
            return this.executeContractFunction(this.ShardingTableContract, 'pushFront', [
                peerId,
                ask,
                stake,
            ]);
        } catch (e) {
            this.logger.error(`Error on executing contract function. ${e}`);
            return false;
        }
    }

    async updatePeerParams(peerId, ask, stake) {
        try {
            return this.executeContractFunction(this.ShardingTableContract, 'updateParams', [
                peerId,
                ask,
                stake,
            ]);
        } catch (e) {
            this.logger.error(`Error on executing contract function. ${e}`);
            return false;
        }
    }

    async removePeer(peerId) {
        try {
            return this.executeContractFunction(this.ShardingTableContract, 'removePeer', [peerId]);
        } catch (e) {
            this.logger.error(`Error on executing contract function. ${e}`);
            return false;
        }
    }
}

export default Web3Service;
