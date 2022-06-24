const Command = require('../../command');

class ResolveFinaliseCommand extends Command {
    constructor(ctx) {
        super(ctx);
        this.logger = ctx.logger;
        this.commandExecutor = ctx.commandExecutor;
    }

    /**
     * Executes command and produces one or more events
     * @param command
     */
    async execute(command) {
        this.logger.info('EXECUTING FINALIZE COMMAND');
        return Command.empty();
    }

    /**
     * Builds default resolveFinalizeCommand
     * @param map
     * @returns {{add, data: *, delay: *, deadline: *}}
     */
    default(map) {
        const command = {
            name: 'resolveFinalizeCommand',
            delay: 0,
            transactional: false,
        };
        Object.assign(command, map);
        return command;
    }
}

module.exports = ResolveFinaliseCommand;