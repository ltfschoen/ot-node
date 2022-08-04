const HandleProtocolMessageCommand = require('../../common/handle-protocol-message-command');
const {
    NETWORK_MESSAGE_TYPES,
    OPERATION_ID_STATUS,
    ERROR_TYPE,
} = require('../../../../constants/constants');

class HandleStoreRequestCommand extends HandleProtocolMessageCommand {
    constructor(ctx) {
        super(ctx);
        this.operationService = ctx.publishService;

        this.errorType = ERROR_TYPE.PUBLISH.PUBLISH_LOCAL_STORE_REMOTE_ERROR;
    }

    async prepareMessage(commandData) {
        const { ual, operationId, assertionId } = commandData;

        await this.operationIdService.updateOperationIdStatus(
            operationId,
            OPERATION_ID_STATUS.PUBLISH.PUBLISH_LOCAL_STORE_START,
        );
        const { assertionId: storeInitAssertionId } =
            await this.operationIdService.getCachedOperationIdData(operationId);

        if (storeInitAssertionId !== assertionId) {
            throw Error('Store request assertion id does not match store init assertion id');
        }

        await this.operationIdService.updateOperationIdStatus(
            operationId,
            OPERATION_ID_STATUS.PUBLISH.VALIDATING_ASSERTION_REMOTE_START,
        );
        await this.operationService.validateAssertion(assertionId, operationId);

        await this.operationIdService.updateOperationIdStatus(
            operationId,
            OPERATION_ID_STATUS.PUBLISH.VALIDATING_ASSERTION_REMOTE_END,
        );

        await this.operationService.localStore(ual, assertionId, operationId);
        await this.operationIdService.updateOperationIdStatus(
            operationId,
            OPERATION_ID_STATUS.PUBLISH.PUBLISH_LOCAL_STORE_END,
        );

        return { messageType: NETWORK_MESSAGE_TYPES.RESPONSES.ACK, messageData: {} };

        //         const {blockchain, tokenId} = this.ualService.resolveUAL(ual);
        //         const epochs = await this.blockchainModuleManager.getEpochs(blockchain, tokenId);
        //         const blockNumber = await this.blockchainModuleManager.getBlockNumber(blockchain);
        //         const blockTime = await this.blockchainModuleManager.getBlockTime(blockchain);
        //         const addCommandPromise = [];
        //         epochs.forEach((epoch) => {
        //             const commandSequence = ['answerChallengeCommand'];
        //             addCommandPromise.push(
        //                 this.commandExecutor.add({
        //                     name: commandSequence[0],
        //                     sequence: commandSequence.slice(1),
        //                     delay: Math.abs((parseInt(epoch, 10)-parseInt(blockNumber, 10))*parseInt(blockTime, 10)),
        //                     data: {
        //                         handlerId,
        //                         epoch,
        //                         tokenId
        //                     },
        //                     transactional: false,
        //                 }),
        //             );
        //         });
        //
        //         await Promise.all(addCommandPromise);
    }

    /**
     * Builds default handleStoreRequestCommand
     * @param map
     * @returns {{add, data: *, delay: *, deadline: *}}
     */
    default(map) {
        const command = {
            name: 'handleStoreRequestCommand',
            delay: 0,
            transactional: false,
        };
        Object.assign(command, map);
        return command;
    }
}

module.exports = HandleStoreRequestCommand;