import { Parser, Reasoner, Store } from 'n3'
import jsonld from 'jsonld'
import type { NodeObject } from 'jsonld'
import { dereferenceToStore } from 'rdf-dereference-store'
import serializeStore from '@jeswr/rdf-serialize-store'
import { statementExists, queryDatasetConstruct, rdf, doap, spec } from '../util.ts'

// @ts-expect-error
const serialize = serializeStore.default

const baseFrame = {
  "@context": {
    "spec": "http://www.w3.org/ns/spec#",
    "schema": "http://schema.org/",
    "name": "schema:name",
    "author": { "@id": "schema:author", "@type": "@id" },
    "editor": { "@id": "schema:editor", "@type": "@id" },
    "definesConformanceFor": { "@id": "spec:definesConformanceFor", "@type": "@id" },
    "ClassOfProduct": { "@id": "spec:ClassOfProduct", "@type": "@id" }
  },
  "@explicit": true,
  "name": {},
  "author": {
    "@embed": "@never",
  },
  "editor": {
    "@embed": "@never",
  },
}

const specificationFrame = {
  ...baseFrame,
  "@type": doap.Specification,
  "definesConformanceFor": {
    "@explicit": true,
    "name": {}
  },
}

const primerFrame = {
  ...baseFrame,
  "@type": spec.Primer,
}

async function fixDescriptionN3(dataset: Store): Promise<Store> {
  const rules = `
    PREFIX spec: <http://www.w3.org/ns/spec#>
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    PREFIX schema: <http://schema.org/>

    {
      ?document spec:classesOfProducts ?scheme .
      ?scheme skos:hasTopConcept ?productClass .
    }
    =>
    {
      ?document spec:definesConformanceFor ?productClass .
    } .
    {
      ?s skos:prefLabel ?o .
    }
    =>
    {
      ?s schema:name ?o .
    } .
  `
  const parser = new Parser({ format: 'text/n3' });
  const rulesDataset = new Store(parser.parse(rules));
  const reasoner = new Reasoner(dataset);
  reasoner.reason(rulesDataset);
  return dataset
}

async function fixDescriptionSPARQL(dataset: Store): Promise<Store> {
  {
    const query = `
    PREFIX spec: <http://www.w3.org/ns/spec#>
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    CONSTRUCT {
      ?document spec:definesConformanceFor ?productClass .
    }
    WHERE {
      ?document spec:classesOfProducts [
        skos:hasTopConcept ?productClass
      ] .
    }`
    const quads = await queryDatasetConstruct(dataset, query)
    dataset.addQuads(quads)
  }
  {
    const query = `
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    PREFIX schema: <http://schema.org/>
    CONSTRUCT {
      ?s schema:name ?o .
    }
    WHERE {
      ?s skos:prefLabel ?o .
    }`
    const quads = await queryDatasetConstruct(dataset, query)
    dataset.addQuads(quads)
  }
  return dataset
}

function cleanupFramed(id: string, object: NodeObject, t?: typeof doap.Specification | typeof spec.Primer): NodeObject {
  let result = object["@graph"]
    //@ts-ignore
    ? { "@context": baseFrame["@context"], ...object["@graph"].find((object: any) => object["@id"] === id) }
    : object
  if (t === doap.Specification) {
    return {
      ...result,
      "@type": "doap:Specification",
      "definesConformanceFor": result.definesConformanceFor?.map((product: any) => ({ ...product, "@type": "ClassOfProduct" }))
    }
  }
  return result
}

export async function aggregateSpecificatons(dataset: Store): Promise<Store> {
  console.info('aggregating specifications')
  const specifications = [
    'https://solidproject.org/TR/wac',
    'https://solidproject.org/TR/protocol',
    'http://0.0.0.0:8000/specification/',
    'http://0.0.0.0:8000/primer/application.html',
    'http://0.0.0.0:8000/primer/authorization-agent.html'
  ]
  for (const url of specifications) {
    try {
      const { store } = await dereferenceToStore(url)
      let t: undefined | typeof doap.Specification | typeof spec.Primer
      let frame = baseFrame
      if (await statementExists(store, null, rdf.terms.type, doap.terms.Specification)) {
        t = doap.Specification
        frame = specificationFrame
      }
      if (await statementExists(store, null, rdf.terms.type, spec.terms.Primer)) {
        t = spec.Primer
        frame = primerFrame
      }
      const fixed = await fixDescriptionN3(store)
      const raw = await serialize(fixed, { contentType: 'application/n-quads' })
      const doc = await jsonld.fromRDF(raw)
      const framed = await jsonld.frame(doc, frame)
      const result = cleanupFramed(url, framed, t)
      console.log(result)
    } catch (err) {
      console.error(err)
      console.error(`Processing failed: ${url}`)
    }
  }
  return dataset
}
