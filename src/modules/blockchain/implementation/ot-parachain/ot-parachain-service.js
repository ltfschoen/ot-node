const Web3Service = require('../web3-service');

class OtParachainService extends Web3Service {
    async getGasPrice() {
        return undefined;
    }
}

module.exports = OtParachainService;
