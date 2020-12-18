"use strict";
/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ElasticSearchService = void 0;
/* eslint-disable no-underscore-dangle */
const url_1 = __importDefault(require("url"));
const errors_1 = require("@elastic/elasticsearch/lib/errors");
const elasticSearch_1 = require("./elasticSearch");
const constants_1 = require("./constants");
const searchInclusions_1 = require("./searchInclusions");
const searchParametersMapping_1 = require("./searchParametersMapping");
const ITERATIVE_INCLUSION_PARAMETERS = ['_include:iterate', '_revinclude:iterate'];
const NON_SEARCHABLE_PARAMETERS = [
    "_getpagesoffset" /* PAGES_OFFSET */,
    "_count" /* COUNT */,
    '_format',
    '_include',
    '_revinclude',
    ...ITERATIVE_INCLUSION_PARAMETERS,
];
const MAX_INCLUDE_ITERATIVE_DEPTH = 5;
// eslint-disable-next-line import/prefer-default-export
class ElasticSearchService {
    /**
     * @param filterRulesForActiveResources - If you are storing both History and Search resources
     * in your elastic search you can filter out your History elements by supplying a filter argument like:
     * [{ match: { documentStatus: 'AVAILABLE' }}]
     * @param cleanUpFunction - If you are storing non-fhir related parameters pass this function to clean
     * the return ES objects
     * @param fhirVersion
     */
    constructor(filterRulesForActiveResources = [], cleanUpFunction = function passThrough(resource) {
        return resource;
    }, fhirVersion = '4.0.1') {
        this.filterRulesForActiveResources = filterRulesForActiveResources;
        this.cleanUpFunction = cleanUpFunction;
        this.fhirVersion = fhirVersion;
    }
    /*
    searchParams => {field: value}
     */
    async typeSearch(request) {
        const { queryParams, resourceType } = request;
        try {
            const from = queryParams["_getpagesoffset" /* PAGES_OFFSET */]
                ? Number(queryParams["_getpagesoffset" /* PAGES_OFFSET */])
                : 0;
            const size = queryParams["_count" /* COUNT */]
                ? Number(queryParams["_count" /* COUNT */])
                : constants_1.DEFAULT_SEARCH_RESULTS_PER_PAGE;
            // Exp. {gender: 'male', name: 'john'}
            const searchParameterToValue = { ...queryParams };
            const must = [];
            // TODO Implement fuzzy matches
            Object.entries(searchParameterToValue).forEach(([searchParameter, value]) => {
                if (NON_SEARCHABLE_PARAMETERS.includes(searchParameter)) {
                    return;
                }
                const field = searchParametersMapping_1.getDocumentField(searchParameter);
                const query = {
                    query_string: {
                        fields: [field],
                        query: value,
                        default_operator: 'AND',
                        lenient: true,
                    },
                };
                must.push(query);
            });
            const filter = this.filterRulesForActiveResources;
            const params = {
                index: resourceType.toLowerCase(),
                from,
                size,
                body: {
                    query: {
                        bool: {
                            must,
                            filter,
                        },
                    },
                },
            };
            const { total, hits } = await this.executeQuery(params);
            const result = {
                numberOfResults: total,
                entries: this.hitsToSearchEntries({ hits, baseUrl: request.baseUrl, mode: 'match' }),
                message: '',
            };
            if (from !== 0) {
                result.previousResultUrl = this.createURL(request.baseUrl, {
                    ...searchParameterToValue,
                    ["_getpagesoffset" /* PAGES_OFFSET */]: from - size,
                    ["_count" /* COUNT */]: size,
                }, resourceType);
            }
            if (from + size < total) {
                result.nextResultUrl = this.createURL(request.baseUrl, {
                    ...searchParameterToValue,
                    ["_getpagesoffset" /* PAGES_OFFSET */]: from + size,
                    ["_count" /* COUNT */]: size,
                }, resourceType);
            }
            const includedResources = await this.processSearchInclusions(result.entries, request);
            result.entries.push(...includedResources);
            const iterativelyIncludedResources = await this.processIterativeSearchInclusions(result.entries, request);
            result.entries.push(...iterativelyIncludedResources);
            return { result };
        }
        catch (error) {
            console.error(error);
            throw error;
        }
    }
    // eslint-disable-next-line class-methods-use-this
    async executeQuery(searchQuery) {
        try {
            const apiResponse = await elasticSearch_1.ElasticSearch.search(searchQuery);
            return {
                total: apiResponse.body.hits.total.value,
                hits: apiResponse.body.hits.hits,
            };
        }
        catch (error) {
            // Indexes are created the first time a resource of a given type is written to DDB.
            if (error instanceof errors_1.ResponseError && error.message === 'index_not_found_exception') {
                console.log(`Search index for ${searchQuery.index} does not exist. Returning an empty search result`);
                return {
                    total: 0,
                    hits: [],
                };
            }
            throw error;
        }
    }
    // eslint-disable-next-line class-methods-use-this
    async executeQueries(searchQueries) {
        if (searchQueries.length === 0) {
            return {
                hits: [],
            };
        }
        const apiResponse = await elasticSearch_1.ElasticSearch.msearch({
            body: searchQueries.flatMap(query => [{ index: query.index }, { query: query.body.query }]),
        });
        return apiResponse.body.responses
            .filter(response => {
            if (response.error) {
                if (response.error.type === 'index_not_found_exception') {
                    // Indexes are created the first time a resource of a given type is written to DDB.
                    console.log(`Search index for ${response.error.index} does not exist. Returning an empty search result`);
                    return false;
                }
                throw response.error;
            }
            return true;
        })
            .reduce((acc, response) => {
            acc.hits.push(...response.hits.hits);
            return acc;
        }, {
            hits: [],
        });
    }
    hitsToSearchEntries({ hits, baseUrl, mode = 'match', }) {
        return hits.map((hit) => {
            // Modify to return resource with FHIR id not Dynamo ID
            const resource = this.cleanUpFunction(hit._source);
            return {
                search: {
                    mode,
                },
                fullUrl: url_1.default.format({
                    host: baseUrl,
                    pathname: `/${resource.resourceType}/${resource.id}`,
                }),
                resource,
            };
        });
    }
    async processSearchInclusions(searchEntries, request, iterative) {
        const includeSearchQueries = searchInclusions_1.buildIncludeQueries(request.queryParams, searchEntries.map(x => x.resource), this.filterRulesForActiveResources, this.fhirVersion, iterative);
        const revIncludeSearchQueries = searchInclusions_1.buildRevIncludeQueries(request.queryParams, searchEntries.map(x => x.resource), this.filterRulesForActiveResources, this.fhirVersion, iterative);
        const lowerCaseAllowedResourceTypes = new Set(request.allowedResourceTypes.map(r => r.toLowerCase()));
        const allowedInclusionQueries = [...includeSearchQueries, ...revIncludeSearchQueries].filter(query => lowerCaseAllowedResourceTypes.has(query.index));
        const { hits } = await this.executeQueries(allowedInclusionQueries);
        return this.hitsToSearchEntries({ hits, baseUrl: request.baseUrl, mode: 'include' });
    }
    async processIterativeSearchInclusions(searchEntries, request) {
        if (!ITERATIVE_INCLUSION_PARAMETERS.some(param => {
            return request.queryParams[param];
        })) {
            return [];
        }
        const result = [];
        const resourceIdsAlreadyInResult = new Set(searchEntries.map(searchEntry => searchEntry.resource.id));
        const resourceIdsWithInclusionsAlreadyResolved = new Set();
        console.log('Iterative inclusion search starts');
        let resourcesToIterate = searchEntries;
        for (let i = 0; i < MAX_INCLUDE_ITERATIVE_DEPTH; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            const resourcesFound = await this.processSearchInclusions(resourcesToIterate, request, true);
            resourcesToIterate.forEach(resource => resourceIdsWithInclusionsAlreadyResolved.add(resource.resource.id));
            if (resourcesFound.length === 0) {
                console.log(`Iteration ${i} found zero results. Stopping`);
                break;
            }
            resourcesFound.forEach(resourceFound => {
                // Avoid duplicates in result. In some cases different include/revinclude clauses can end up finding the same resource.
                if (!resourceIdsAlreadyInResult.has(resourceFound.resource.id)) {
                    resourceIdsAlreadyInResult.add(resourceFound.resource.id);
                    result.push(resourceFound);
                }
            });
            if (i === MAX_INCLUDE_ITERATIVE_DEPTH - 1) {
                console.log('MAX_INCLUDE_ITERATIVE_DEPTH reached. Stopping');
                break;
            }
            resourcesToIterate = resourcesFound.filter(r => !resourceIdsWithInclusionsAlreadyResolved.has(r.resource.id));
            console.log(`Iteration ${i} found ${resourcesFound.length} resources`);
        }
        return result;
    }
    // eslint-disable-next-line class-methods-use-this
    createURL(host, query, resourceType) {
        return url_1.default.format({
            host,
            pathname: `/${resourceType}`,
            query,
        });
    }
    // eslint-disable-next-line class-methods-use-this
    async globalSearch(request) {
        console.log(request);
        throw new Error('Method not implemented.');
    }
}
exports.ElasticSearchService = ElasticSearchService;
//# sourceMappingURL=elasticSearchService.js.map