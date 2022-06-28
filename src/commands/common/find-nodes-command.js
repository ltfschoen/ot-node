const Command = require('../command');
const { ERROR_TYPE, HANDLER_ID_STATUS } = require('../../constants/constants');

class FindNodesCommand extends Command {
    constructor(ctx) {
        super(ctx);
        this.logger = ctx.logger;
        this.config = ctx.config;
        this.networkModuleManager = ctx.networkModuleManager;
        this.handlerIdService = ctx.handlerIdService;
        this.repositoryModuleManager = ctx.repositoryModuleManager;
    }

    /**
     * Executes command and produces one or more events
     * @param command
     */
    async execute(command) {
        const { handlerId, networkProtocol } = command.data;

        const keys = this.extractKeys(command.data);

        this.logger.info(
            `Searching for closest ${
                this.config.replicationFactor
            } node(s) for keywords: ${keys.toString()}`,
        );

        const findNodesPromises = [];

        keys.forEach((key) => {
            findNodesPromises.push(this.findRankedNodes(key, networkProtocol, handlerId));
        });

        const results = await Promise.all(findNodesPromises);

        let nodes = new Set();
        for (const closestNodes of results) {
            for (const node of closestNodes) {
                nodes.add(node);
            }
        }
        nodes = [...nodes];

        const commandData = command.data;
        commandData.nodes = nodes;

        return this.continueSequence(commandData, command.sequence);
    }

    async findRankedNodes(key, protocol, handlerId) {
        this.logger.debug(
            `Searching for closest ${this.config.replicationFactor} node(s) for keyword ${key}`,
        );

        await this.handlerIdService.updateHandlerIdStatus(
            handlerId,
            HANDLER_ID_STATUS.FIND_NODES_START,
        );

        const foundNodes = await this.networkModuleManager.findNodes(key, protocol);

        const closestNodes = await this.networkModuleManager.rankNodes(foundNodes, key);
        this.logger.debug(`Found ${closestNodes.length} node(s) for keyword ${key}`);

        await this.handlerIdService.updateHandlerIdStatus(
            handlerId,
            HANDLER_ID_STATUS.FIND_NODES_END,
        );

        return closestNodes;
    }

    extractKeys(commandData) {
        const acceptableKeywords = ['query', 'ual', 'assertionId'];
        const keys = [];
        for (const property in commandData) {
            if (acceptableKeywords.includes(property)) {
                keys.push(commandData[property]);
            }
        }
        return keys;
    }

    /**
     * Builds default findNodesCommand
     * @param map
     * @returns {{add, data: *, delay: *, deadline: *}}
     */
    default(map) {
        const command = {
            name: 'findNodesCommand',
            delay: 0,
            transactional: false,
            errorType: ERROR_TYPE.FIND_NODES_ERROR,
        };
        Object.assign(command, map);
        return command;
    }
}

module.exports = FindNodesCommand;
