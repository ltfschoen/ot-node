const bytes = require('utf8-length');
const uuidv4 = require('uuid/v4');
const { sha3_256 } = require('js-sha3');

const Utilities = require('./Utilities');
const MerkleTree = require('./Merkle');
const Graph = require('./Graph');
const Encryption = require('./Encryption');
const { normalizeGraph } = require('./Database/graph-converter');
const Models = require('../models');
const constants = require('./constants');
const crypto = require('crypto');
const abi = require('ethereumjs-abi');

/**
 * Import related utilities
 */
class ImportUtilities {
    /**
     * Hides _key attributes
     * @param vertices
     * @param edges
     * @param color
     */
    static packKeys(vertices, edges, color) {
        for (const vertex of vertices) {
            if (!vertex._dc_key) {
                vertex._dc_key = vertex._key;
                vertex._key = uuidv4();
            }
            vertex.encrypted = color;
        }
        // map _from and _to
        const find = (key) => {
            const filtered = vertices.filter(v => v._dc_key === key);
            if (filtered.length > 0) {
                return filtered[0]._key;
            }
            return null;
        };
        for (const edge of edges) {
            const from = find(edge._from);
            if (from) {
                edge._from = from;
            }
            const to = find(edge._to);
            if (to) {
                edge._to = to;
            }

            edge.encrypted = color;
        }
        for (const edge of edges) {
            if (!edge._dc_key) {
                edge._dc_key = edge._key;
                edge._key = uuidv4();
            }
        }
    }

    /**
     * Restores _key attributes
     * @param vertices
     * @param edges
     */
    static unpackKeys(vertices, edges) {
        const mapping = {};
        for (const vertex of vertices) {
            if (vertex._dc_key) {
                mapping[vertex._key] = vertex._dc_key;
                vertex._key = vertex._dc_key;
                delete vertex._dc_key;
            }
            delete vertex.encrypted;
        }
        for (const edge of edges) {
            if (edge._dc_key) {
                edge._key = edge._dc_key;
                delete edge._dc_key;

                if (mapping[edge._from]) {
                    edge._from = mapping[edge._from];
                }
                if (mapping[edge._to]) {
                    edge._to = mapping[edge._to];
                }
            }
            delete edge.encrypted;
        }
    }

    /**
     * Format empty identifiers, properties and relations format from a graph.
     * @param graph
     */
    static formatGraph(graph) {
        graph.filter(vertex => vertex['@type'] === 'otObject').forEach((vertex) => {
            if (vertex.identifiers == null) {
                vertex.identifiers = [];
            }
            if (vertex.properties != null && Object.keys(vertex.properties).length === 0) {
                delete vertex.properties;
            }
            if (vertex.relations == null) {
                vertex.relations = [];
            } else {
                vertex.relations.forEach((relation) => {
                    if (relation.direction == null) {
                        relation.direction = 'direct';
                    }
                });
            }
        });
        return graph;
    }

    static prepareDataset(document, config, web3) {
        const graph = document['@graph'];
        const datasetHeader = document.datasetHeader ? document.datasetHeader : {};
        ImportUtilities.calculateGraphPrivateDataHashes(graph);
        const id = this.calculateGraphPublicHash(graph);

        const header = this.createDatasetHeader(
            config, null,
            datasetHeader.datasetTags,
            datasetHeader.datasetTitle,
            datasetHeader.datasetDescription,
            datasetHeader.OTJSONVersion,
        );
        const dataset = {
            '@id': id,
            '@type': 'Dataset',
            datasetHeader: header,
            '@graph': graph,
        };

        const rootHash = this.calculateDatasetRootHash(dataset['@graph'], id, header.dataCreator);
        dataset.datasetHeader.dataIntegrity.proofs[0].proofValue = rootHash;

        const signed = this.signDataset(dataset, config, web3);
        return signed;
    }

    /**
     * Decrypt encrypted OT-JSON dataset
     * @param dataset - OT-JSON dataset
     * @param decryptionKey - Decryption key
     * @param offerId - Replication identifier from which the dataset was received
     * @param encryptionColor - Encryption color
     * @returns Decrypted OTJson dataset
     */
    static decryptDataset(dataset, decryptionKey, offerId = null, encryptionColor = null) {
        const decryptedDataset = Utilities.copyObject(dataset);
        const encryptedMap = {};
        encryptedMap.objects = {};
        encryptedMap.relations = {};
        const colorMap = {
            0: 'red',
            1: 'green',
            2: 'blue',
        };

        for (const obj of decryptedDataset['@graph']) {
            if (obj.properties != null) {
                const encryptedProperties = obj.properties;
                obj.properties = Encryption.decryptObject(obj.properties, decryptionKey);
                if (encryptionColor != null) {
                    const encColor = colorMap[encryptionColor];
                    encryptedMap.objects[obj['@id']] = {};
                    encryptedMap.objects[obj['@id']][offerId] = {};
                    encryptedMap.objects[obj['@id']][offerId][encColor] = encryptedProperties;
                }
            }
            if (obj.relations != null) {
                encryptedMap.relations[obj['@id']] = {};
                for (const rel of obj.relations) {
                    if (rel.properties != null) {
                        const encryptedProperties = rel.properties;
                        rel.properties = Encryption.decryptObject(rel.properties, decryptionKey);
                        if (encryptionColor != null) {
                            const encColor = colorMap[encryptionColor];
                            const relationKey = sha3_256(Utilities.stringify(rel, 0));
                            encryptedMap.relations[obj['@id']][relationKey] = {};
                            encryptedMap.relations[obj['@id']][relationKey][offerId] = {};
                            encryptedMap.relations[obj['@id']][relationKey][offerId][encColor] =
                                encryptedProperties;
                        }
                    }
                }
            }
        }
        return {
            decryptedDataset,
            encryptedMap,
        };
    }


    static encryptDataset(dataset, encryptionKey) {
        const encryptedDataset = Utilities.copyObject(dataset);

        for (const obj of encryptedDataset['@graph']) {
            if (obj.properties != null) {
                const encryptedProperties = Encryption.encryptObject(obj.properties, encryptionKey);
                obj.properties = encryptedProperties;
            }
            if (obj.relations != null) {
                for (const rel of obj.relations) {
                    if (rel.properties != null) {
                        const encryptedProperties =
                            Encryption.encryptObject(rel.properties, encryptionKey);
                        rel.properties = encryptedProperties;
                    }
                }
            }
        }
        return encryptedDataset;
    }

    /**
     * Normalizes import (use just necessary data)
     * @param dataSetId - Dataset ID
     * @param vertices - Import vertices
     * @param edges - Import edges
     * @returns {{edges: *, vertices: *}}
     */
    static normalizeImport(dataSetId, vertices, edges) {
        ImportUtilities.sort(edges);
        ImportUtilities.sort(vertices);

        const { vertices: normVertices, edges: normEdges } = normalizeGraph(
            dataSetId,
            vertices,
            edges,
        );

        return Utilities.sortObject({
            edges: normEdges,
            vertices: normVertices,
        });
    }

    /**
     * Calculate import hash
     * @param dataSetId Data set ID
     * @param vertices  Import vertices
     * @param edges     Import edges
     * @returns {*}
     */
    static importHash(dataSetId, vertices, edges) {
        const normalized = ImportUtilities.normalizeImport(dataSetId, vertices, edges);
        return Utilities.normalizeHex(sha3_256(Utilities.stringify(normalized, 0)));
    }

    /**
     * Creates Merkle tree from import data
     * @param vertices  Import vertices
     * @param edges     Import edges
     * @return {Promise<{tree: MerkleTree, leaves: Array, hashPairs: Array}>}
     */
    static async merkleStructure(vertices, edges) {
        ImportUtilities.sort(edges);
        ImportUtilities.sort(vertices);

        const leaves = [];
        const hashPairs = [];

        // process vertices
        for (const i in vertices) {
            const hash = Utilities.soliditySHA3(Utilities.sortObject({
                identifiers: vertices[i].identifiers,
                data: vertices[i].data,
            }));
            leaves.push(hash);
            hashPairs.push({
                key: vertices[i]._key,
                hash,
            });
        }

        for (const edge of edges) {
            const hash = Utilities.soliditySHA3(Utilities.sortObject({
                identifiers: edge.identifiers,
                _from: edge._from,
                _to: edge._to,
                edge_type: edge.edge_type,
            }));
            leaves.push(hash);
            hashPairs.push({
                key: edge._key,
                hash,
            });
        }

        leaves.sort();
        const tree = new MerkleTree(leaves);
        return {
            tree,
            leaves,
            hashPairs,
        };
    }

    static sort(documents, key = '_key') {
        const sort = (a, b) => {
            if (a[key] < b[key]) {
                return -1;
            } else if (a[key] > b[key]) {
                return 1;
            }
            return 0;
        };
        documents.sort(sort);
    }

    static compareDocuments(documents1, documents2) {
        ImportUtilities.sort(documents1);
        ImportUtilities.sort(documents2);

        for (const index in documents1) {
            const distance = Utilities.objectDistance(documents1[index], documents2[index]);
            if (distance !== 100) {
                return false;
            }
        }
        return true;
    }

    static calculateDatasetSummary(graph, datasetId, datasetCreator) {
        return {
            datasetId,
            datasetCreator,
            objects: graph.map(vertex => ({
                '@id': vertex['@id'],
                identifiers: vertex.identifiers != null ? vertex.identifiers : [],
            })),
            numRelations: graph.filter(vertex => vertex.relations != null)
                .reduce((acc, value) => acc + value.relations.length, 0),
        };
    }

    static createDistributionMerkleTree(graph, datasetId, datasetCreator) {
        const datasetSummary =
            this.calculateDatasetSummary(graph, datasetId, datasetCreator);

        const stringifiedGraph = [];
        for (const obj of graph) {
            stringifiedGraph.push(Utilities.sortedStringify(obj));
        }

        return new MerkleTree(
            [Utilities.sortedStringify(datasetSummary), ...stringifiedGraph],
            'distribution',
            'sha3',
        );
    }

    static calculateDatasetRootHash(graph, datasetId, datasetCreator) {
        const publicGraph = Utilities.copyObject(graph);
        ImportUtilities.removeGraphPrivateData(publicGraph);

        ImportUtilities.sortGraphRecursively(publicGraph);

        const merkle = ImportUtilities.createDistributionMerkleTree(
            publicGraph,
            datasetId,
            datasetCreator,
        );

        return merkle.getRoot();
    }

    /**
     * Sort @graph data inline
     * @param graph
     */
    static sortGraphRecursively(graph) {
        graph.forEach((el) => {
            if (el.relations) {
                el.relations.sort((r1, r2) => sha3_256(Utilities.sortedStringify(r1))
                    .localeCompare(sha3_256(Utilities.sortedStringify(r2))));
            }

            if (el.identifiers) {
                el.identifiers.sort((r1, r2) => sha3_256(Utilities.sortedStringify(r1))
                    .localeCompare(sha3_256(Utilities.sortedStringify(r2))));
            }
        });
        graph.sort((e1, e2) => (Object.keys(e1['@id']).length > 0 ? e1['@id'].localeCompare(e2['@id']) : 0));
        return Utilities.sortedStringify(graph, true);
    }

    /**
     * Calculates more or less accurate size of the import
     * @param vertices   Collection of vertices
     * @returns {number} Size in bytes
     */
    static calculateEncryptedImportSize(vertices) {
        const keyPair = Encryption.generateKeyPair(); // generate random pair of keys
        Graph.encryptVertices(vertices, keyPair.privateKey);
        return bytes(JSON.stringify(vertices));
    }

    /**
     * Deletes internal vertex data
     * @param vertices
     */
    static deleteInternal(vertices) {
        for (const vertex of vertices) {
            delete vertex.datasets;
            delete vertex.private;
            delete vertex.version;
        }
    }

    /**
     * Encrypt vertices data with specified private key.
     *
     * All vertices that has data property will be encrypted with given private key.
     * @param vertices Vertices to encrypt
     * @param privateKey Encryption key
     */
    static immutableEncryptVertices(vertices, privateKey) {
        const copy = Utilities.copyObject(vertices);
        for (const id in copy) {
            const vertex = copy[id];
            if (vertex.data) {
                vertex.data = Encryption.encryptObject(vertex.data, privateKey);
            }
        }
        return copy;
    }

    /**
     * Decrypts vertices with a public key
     * @param vertices      Encrypted vertices
     * @param public_key    Public key
     * @returns {*}
     */
    static immutableDecryptVertices(vertices, public_key) {
        const copy = Utilities.copyObject(vertices);
        for (const id in copy) {
            if (copy[id].data) {
                copy[id].data = Encryption.decryptObject(copy[id].data, public_key);
            }
        }
        return copy;
    }

    /**
     * Gets transaction hash for the data set
     * @param dataSetId Data set ID
     * @param origin    Data set origin
     * @return {Promise<string|null>}
     */
    static async getTransactionHash(dataSetId, origin) {
        let transactionHash = null;

        switch (origin) {
        case 'PURCHASED': {
            const purchasedData = await Models.purchased_data.findOne({
                where: { data_set_id: dataSetId },
            });
            transactionHash = purchasedData.transaction_hash;
            break;
        }
        case 'HOLDING': {
            const holdingData = await Models.holding_data.findOne({
                where: { data_set_id: dataSetId },
            });
            transactionHash = holdingData.transaction_hash;
            break;
        }
        case 'IMPORTED': {
            // TODO support many offers for the same data set
            const offers = await Models.offers.findAll({
                where: { data_set_id: dataSetId },
            });
            if (offers.length > 0) {
                transactionHash = offers[0].transaction_hash;
            }
            break;
        }
        default:
            throw new Error(`Failed to find transaction hash for ${dataSetId} and origin ${origin}. Origin not valid.`);
        }
        return transactionHash;
    }

    /**
     * Create SHA256 Hash of graph
     * @param graph
     * @returns {string}
     */
    static calculateGraphHash(graph) {
        const sorted = this.sortGraphRecursively(graph);
        return `0x${sha3_256(sorted, null, 0)}`;
    }

    /**
     * Create SHA256 Hash of public part of one graph
     * @param graph
     * @returns {string}
     */
    static calculateGraphPublicHash(graph) {
        const public_data = Utilities.copyObject(graph);
        ImportUtilities.removeGraphPrivateData(public_data);
        const sorted = ImportUtilities.sortGraphRecursively(public_data);
        return `0x${sha3_256(sorted, null, 0)}`;
    }


    /**
     * Removes the data attribute from objects that are private
     * @param graph
     * @returns {Array}
     */
    static getGraphPrivateData(graph) {
        const result = [];
        graph.forEach((ot_object) => {
            if (ot_object && ot_object.properties) {
                constants.PRIVATE_DATA_OBJECT_NAMES.forEach((private_data_array) => {
                    if (ot_object.properties[private_data_array] &&
                        Array.isArray(ot_object.properties[private_data_array])) {
                        ot_object.properties[private_data_array].forEach((private_object) => {
                            if (private_object.isPrivate && !result.includes(ot_object['@id'])) {
                                result.push(ot_object['@id']);
                            }
                        });
                    }
                });
            }
        });
        return result;
    }

    /**
     * Removes the data attribute from objects that are private
     * @param graph
     * @returns {Array}
     */
    static hideGraphPrivateData(graph) {
        graph.forEach((object) => {
            ImportUtilities.hideObjectPrivateData(object);
        });
    }

    /**
     * Removes the data attribute from objects if it is set to private
     * @param ot_object
     * @returns {object}
     */
    static hideObjectPrivateData(ot_object) {
        if (!ot_object || !ot_object.properties) {
            return;
        }
        constants.PRIVATE_DATA_OBJECT_NAMES.forEach((private_data_array) => {
            if (ot_object.properties[private_data_array] &&
                Array.isArray(ot_object.properties[private_data_array])) {
                ot_object.properties[private_data_array].forEach((private_object) => {
                    if (private_object.isPrivate) {
                        delete private_object.data;
                    }
                });
            }
        });
    }

    /**
     * Removes the isPrivate and data attributes from all data that can be private
     * @param graph
     * @returns {null}
     */
    static removeGraphPrivateData(graph) {
        graph.forEach((object) => {
            ImportUtilities.removeObjectPrivateData(object);
        });
    }

    /**
     * Removes the isPrivate and data attributes from one ot-json object
     * @param ot_object
     * @returns {null}
     */
    static removeObjectPrivateData(ot_object) {
        if (!ot_object || !ot_object.properties) {
            return;
        }
        constants.PRIVATE_DATA_OBJECT_NAMES.forEach((private_data_array) => {
            if (ot_object.properties[private_data_array] &&
                Array.isArray(ot_object.properties[private_data_array])) {
                ot_object.properties[private_data_array].forEach((private_object) => {
                    delete private_object.isPrivate;
                    delete private_object.data;
                });
            }
        });
    }

    /**
     * Add the private data hash to each graph object
     * @param graph
     * @returns {null}
     */
    static calculateGraphPrivateDataHashes(graph) {
        graph.forEach((object) => {
            ImportUtilities.calculateObjectPrivateDataHashes(object);
        });
    }

    /**
     * Add private data hash to each object in PRIVATE_DATA_OBJECT_NAMES ot_object properties
     * @param ot_object
     * @returns {null}
     */
    static calculateObjectPrivateDataHashes(ot_object) {
        if (!ot_object || !ot_object.properties) {
            throw Error(`Cannot calculate private data hash for invalid ot-json object ${ot_object}`);
        }
        constants.PRIVATE_DATA_OBJECT_NAMES.forEach((private_data_array) => {
            if (ot_object.properties[private_data_array] &&
                Array.isArray(ot_object.properties[private_data_array])) {
                ot_object.properties[private_data_array].forEach((private_object) => {
                    const privateHash = ImportUtilities.calculatePrivateDataHash(private_object);
                    private_object.private_data_hash = privateHash;
                });
            }
        });
    }

    /**
     * Calculates the merkle tree root hash of an object
     * The object is sliced to DEFAULT_CHALLENGE_BLOCK_SIZE_BYTES sized blocks (potentially padded)
     * The tree contains at least NUMBER_OF_PRIVATE_DATA_FIRST_LEVEL_BLOCKS
     * @param private_object
     * @returns {null}
     */
    static calculatePrivateDataHash(private_object, type = 'distribution') {
        const merkleTree = this.calculatePrivateDataMerkleTree(private_object, type);
        return merkleTree.getRoot();
    }

    /**
     * Calculates the merkle tree of an object
     * The object is sliced to DEFAULT_CHALLENGE_BLOCK_SIZE_BYTES sized blocks (potentially padded)
     * The tree contains at least NUMBER_OF_PRIVATE_DATA_FIRST_LEVEL_BLOCKS
     * @param private_object
     * @returns {null}
     */
    static calculatePrivateDataMerkleTree(private_object, type = 'distribution') {
        if (!private_object || !private_object.data) {
            throw Error('Cannot calculate root hash of an empty object');
        }
        const sorted_data = Utilities.sortedStringify(private_object.data, true);
        const data = Buffer.from(sorted_data);

        const first_level_blocks = constants.NUMBER_OF_PRIVATE_DATA_FIRST_LEVEL_BLOCKS;
        const default_block_size = constants.DEFAULT_CHALLENGE_BLOCK_SIZE_BYTES;

        let block_size = Math.min(Math.round(data.length / first_level_blocks), default_block_size);
        block_size = block_size < 1 ? 1 : block_size;

        const blocks = [];
        for (let i = 0; i < data.length || blocks.length < first_level_blocks; i += block_size) {
            const block = data.slice(i, i + block_size).toString('hex');
            blocks.push(block.padStart(64, '0'));
        }
        const merkleTree = new MerkleTree(blocks, type, 'sha3');
        return merkleTree;
    }

    static encodePrivateData(privateObject) {
        const merkleTree = ImportUtilities.calculatePrivateDataMerkleTree(privateObject, 'purchase');
        const rawKey = crypto.randomBytes(32);
        const key = Utilities.normalizeHex(Buffer.from(`${rawKey}`, 'utf8').toString('hex').padStart(64, '0'));
        const encodedArray = [];
        let index = 0;
        merkleTree.levels.forEach((level) => {
            for (let i = 0; i < level.length; i += 1) {
                const leaf = level[i];
                const keyHash = abi.soliditySHA3(
                    ['bytes32', 'uint256'],
                    [key, index],
                ).toString('hex');
                encodedArray.push(Encryption.xor(leaf, keyHash));
                index += 1;
            }
        });
        const encodedMerkleTree = new MerkleTree(encodedArray, 'purchase', 'sha3');
        const encodedDataRootHash = encodedMerkleTree.getRoot();
        const sorted_data = Utilities.sortedStringify(privateObject.data, true);
        const data = Buffer.from(sorted_data);
        return {
            private_data_original_length: data.length,
            private_data_array_length: merkleTree.levels[0].length,
            key,
            encoded_data: encodedArray,
            private_data_root_hash: Utilities.normalizeHex(privateObject.private_data_hash),
            encoded_data_root_hash: Utilities.normalizeHex(encodedDataRootHash),
        };
    }

    static validateAndDecodePrivateData(
        privateDataArray, key,
        private_data_array_length,
        private_data_original_length,
    ) {
        const decodedDataArray = [];
        privateDataArray.forEach((element, index) => {
            const keyHash = abi.soliditySHA3(
                ['bytes32', 'uint256'],
                [key, index],
            ).toString('hex');
            decodedDataArray.push(Encryption.xor(element, keyHash));
        });

        const originalDataArray = decodedDataArray.slice(0, private_data_array_length);

        // todo add validation
        // const originalDataMarkleTree = new MerkleTree(originalDataArray, 'purchase', 'sha3');
        // var index = 0;
        // originalDataMarkleTree.levels.forEach((level) => {
        //     level.forEach((leaf) => {
        //         if (leaf !== decodedDataArray[index]){
        //             //found non matching index
        //             return {
        //                 : {},
        //                 errorStatus: 'VALIDATION_FAILED',
        //             };
        //         }
        //         index += 1;
        //     });
        // });

        // recreate original object

        const first_level_blocks = constants.NUMBER_OF_PRIVATE_DATA_FIRST_LEVEL_BLOCKS;
        const default_block_size = constants.DEFAULT_CHALLENGE_BLOCK_SIZE_BYTES;

        let block_size = Math.min(Math
            .round(private_data_original_length / first_level_blocks), default_block_size);
        block_size = block_size < 1 ? 1 : block_size;

        let originalDataString = '';
        for (let i = 0; i < originalDataArray.length; i += 1) {
            const dataElement = Buffer.from(originalDataArray[i], 'hex');
            const block = dataElement.slice(dataElement.length - block_size, dataElement.length);
            originalDataString += block.toString();
        }

        return {
            privateData: JSON.parse(originalDataString),
        };
    }

    static decodePrivateDataArray(encodedPrivateDataArray, key) {

    }

    static sortStringifyDataset(dataset) {
        ImportUtilities.sortGraphRecursively(dataset['@graph']);
        return Utilities.sortedStringify(dataset);
    }

    /**
     * Sign OT-JSON
     * @static
     */
    static signDataset(otjson, config, web3) {
        const privateGraph = Utilities.copyObject(otjson['@graph']);
        ImportUtilities.removeGraphPrivateData(otjson['@graph']);
        const stringifiedOtjson = this.sortStringifyDataset(otjson);
        const { signature } = web3.eth.accounts.sign(
            stringifiedOtjson,
            Utilities.normalizeHex(config.node_private_key),
        );
        otjson.signature = {
            value: signature,
            type: 'ethereum-signature',
        };

        otjson['@graph'] = privateGraph;
        return otjson;
    }

    /**
     * Extract Signer from OT-JSON signature
     * @static
     */
    static extractDatasetSigner(otjson, web3) {
        const strippedOtjson = Object.assign({}, otjson);
        delete strippedOtjson.signature;

        const stringifiedOtjson = this.sortStringifyDataset(strippedOtjson);
        return web3.eth.accounts.recover(stringifiedOtjson, otjson.signature.value);
    }


    /**
     * Fill in dataset header
     * @private
     */
    static createDatasetHeader(config, transpilationInfo = null, datasetTags = [], datasetTitle = '', datasetDescription = '', OTJSONVersion = '1.0') {
        const header = {
            OTJSONVersion,
            datasetCreationTimestamp: new Date().toISOString(),
            datasetTitle,
            datasetDescription,
            datasetTags,
            /*
            relatedDatasets may contain objects like this:
            {
                datasetId: '0x620867dced3a96809fc69d579b2684a7',
                relationType: 'UPDATED',
                relationDescription: 'Some long description',
                relationDirection: 'direct',
            }
             */
            relatedDatasets: [],
            validationSchemas: {
                'erc725-main': {
                    schemaType: 'ethereum-725',
                    networkId: config.blockchain.network_id,
                },
                merkleRoot: {
                    schemaType: 'merkle-root',
                    networkId: config.blockchain.network_id,
                    hubContractAddress: config.blockchain.hub_contract_address,
                    // TODO: Add holding contract address and version. Hub address is useless.
                },
            },
            dataIntegrity: {
                proofs: [
                    {
                        proofValue: '',
                        proofType: 'merkleRootHash',
                        validationSchema: '/schemas/merkleRoot',
                    },
                ],
            },
            dataCreator: {
                identifiers: [
                    {
                        identifierValue: config.erc725Identity,
                        identifierType: 'ERC725',
                        validationSchema: '/schemas/erc725-main',
                    },
                ],
            },
        };

        if (transpilationInfo) {
            header.transpilationInfo = transpilationInfo;
        }

        return header;
    }

    /**
     * Extract Dataset creator identifier value from OT-JSON or graph header
     * @static
     * @param datasetHeader Header of the dataset in which the dataCreator field exists
     * @returns String - Dataset creator identifier value (Currently ERC725 Identity)
     */
    static getDataCreator(datasetHeader) {
        return datasetHeader.dataCreator.identifiers[0].identifierValue;
    }

    /**
     * Process successfull import
     * @static
     * @param unpack  Unpack keys
     * @param objects  Graph vertices and edges
     * @return {Promise<>}
     */
    static unpackKeysAndSortVertices(objects, unpack = false) {
        let {
            vertices, edges,
        } = objects;
        if (unpack) {
            ImportUtilities.unpackKeys(vertices, edges);
        }

        edges = Graph.sortVertices(edges);
        vertices = Graph.sortVertices(vertices);

        return {
            vertices,
            edges,
        };
    }
}

module.exports = ImportUtilities;
