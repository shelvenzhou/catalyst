import { ChainId } from '@dcl/schemas'
import { Entity, EntityType } from 'dcl-catalyst-commons'
import { Request, Response } from 'express'
import sharp from 'sharp'
import { ServiceError } from '../../../utils/errors'
import { SmartContentClient } from '../../../utils/SmartContentClient'
import { TheGraphClient } from '../../../utils/TheGraphClient'
import { BASE_AVATARS_COLLECTION_ID } from '../off-chain/OffChainWearablesManager'
import {
  Collection,
  ERC721StandardTrait,
  WearableBodyShape,
  WearableMetadata,
  WearableMetadataRepresentation
} from '../types'
import { createExternalContentUrl, findHashForFile, preferEnglish } from '../Utils'

const DEFAULT_IMAGE_SIZE = '1024'
type ValidSize = '128' | '256' | '512' | typeof DEFAULT_IMAGE_SIZE
const sizes: Record<ValidSize, number> = { '128': 128, '256': 256, '512': 512, '1024': 1024 }

const isValidSize = (size: string): size is ValidSize => sizes[size] !== undefined

const rarityBackgrounds: Record<string, Buffer> = {}
const getRarityBackground = async (rarity: string): Promise<Buffer> => {
  if (rarityBackgrounds[rarity]) return rarityBackgrounds[rarity]

  const path = getRarityImagePath(rarity)
  const image = await sharp(path).toBuffer()
  rarityBackgrounds[rarity] = image
  return image
}

export async function getStandardErc721(client: SmartContentClient, req: Request, res: Response): Promise<void> {
  // Method: GET
  // Path: /standard/erc721/:chainId/:contract/:option/:emission
  const { chainId, contract, option } = req.params
  const emission: string | undefined = req.params.emission
  const protocol = getProtocol(chainId)

  if (!protocol) {
    res.status(400).send(`Invalid chainId '${chainId}'`)
    return
  }

  try {
    const urn = buildUrn(protocol, contract, option)
    const entity = await fetchEntity(client, urn)

    const wearableMetadata: WearableMetadata = entity.metadata
    const name = preferEnglish(wearableMetadata.i18n)
    const totalEmission = RARITIES_EMISSIONS[wearableMetadata.rarity]
    const description = emission ? `DCL Wearable ${emission}/${totalEmission}` : ''
    const image = createExternalContentUrl(client, entity, wearableMetadata.image)
    const thumbnail = createExternalContentUrl(client, entity, wearableMetadata.thumbnail)
    const bodyShapeTraits = getBodyShapes(wearableMetadata.data.representations).reduce(
      (bodyShapes: ERC721StandardTrait[], bodyShape) => {
        bodyShapes.push({
          trait_type: 'Body Shape',
          value: bodyShape
        })

        return bodyShapes
      },
      []
    )

    const tagTraits = wearableMetadata.data.tags.reduce((tags: ERC721StandardTrait[], tag) => {
      tags.push({
        trait_type: 'Tag',
        value: tag
      })

      return tags
    }, [])

    const standardErc721 = {
      id: urn,
      name,
      description,
      language: 'en-US',
      image,
      thumbnail,
      attributes: [
        {
          trait_type: 'Rarity',
          value: wearableMetadata.rarity
        },
        {
          trait_type: 'Category',
          value: wearableMetadata.data.category
        },
        ...tagTraits,
        ...bodyShapeTraits
      ]
    }
    res.send(standardErc721)
  } catch (e) {
    res.status(e.statusCode ?? 500).send(e.message)
  }
}

export async function contentsThumbnail(client: SmartContentClient, req: Request, res: Response): Promise<void> {
  // Method: GET
  // Path: /contents/:urn/thumbnail/:size
  const { urn } = req.params
  let { size } = req.params
  size = size ?? '1024'

  const validSize = sizes[size]
  const imageTransformer = async (image: Buffer): Promise<Buffer> =>
    await sharp(image).resize({ width: validSize, height: validSize }).toBuffer()

  await prepareAndSendImage(client, res, urn, imageTransformer, size)
}

export async function contentsImage(client: SmartContentClient, req: Request, res: Response): Promise<void> {
  // Method: GET
  // Path: /contents/:urn/image/:size
  const { urn } = req.params
  let { size } = req.params
  size = size ?? DEFAULT_IMAGE_SIZE

  const imageTransformer = async (image: Buffer, rarity: string): Promise<Buffer> => {
    const resize = (image: Buffer) => sharp(image).resize({ width: sizes[size] })
    image = await resize(image).toBuffer()
    const rarityBackground = await getRarityBackground(rarity)
    return await resize(rarityBackground)
      .composite([{ input: image }])
      .toBuffer()
  }
  await prepareAndSendImage(client, res, urn, imageTransformer, size)
}

async function prepareAndSendImage(
  client: SmartContentClient,
  res: Response,
  urn: string,
  processImage: (image: Buffer, rarity?: string) => Promise<Buffer>,
  size: string = '1024'
) {
  try {
    validateSize(size)

    const entity = await fetchEntity(client, urn)
    const wearableMetadata = entity.metadata as WearableMetadata
    const hash = getFileHash(entity, wearableMetadata.thumbnail)
    let image = await client.downloadContent(hash)
    image = await processImage(image, wearableMetadata.rarity)

    res.send(image)
    res.writeHead(200, {
      'Content-Type': 'image/png',
      ETag: JSON.stringify(urn + '-' + size),
      'Access-Control-Expose-Headers': '*',
      'Cache-Control': 'public, max-age=31536000, immutable'
    })
  } catch (e) {
    res.status(e.statusCode ?? 500).send(e.message)
  }
}

function getRarityImagePath(rarity: string) {
  return `lambdas/resources/${rarity}.png`
}

export async function getCollectionsHandler(
  theGraphClient: TheGraphClient,
  req: Request,
  res: Response
): Promise<void> {
  // Method: GET
  // Path: /

  try {
    const collections: Collection[] = await getCollections(theGraphClient)
    res.send({ collections })
  } catch (error) {
    res.status(500).send(error.message)
  }
}

export async function getCollections(theGraphClient: TheGraphClient): Promise<Collection[]> {
  const onChainCollections = await theGraphClient.getAllCollections()
  return [
    {
      id: BASE_AVATARS_COLLECTION_ID,
      name: 'Base Wearables'
    },
    ...onChainCollections.map(({ urn, name }) => ({ id: urn, name }))
  ]
}

function getProtocol(chainId: string): string | undefined {
  switch (parseInt(chainId, 10)) {
    case ChainId.ETHEREUM_MAINNET:
      return 'ethereum'
    case ChainId.ETHEREUM_ROPSTEN:
      return 'ropsten'
    case ChainId.ETHEREUM_RINKEBY:
      return 'rinkeby'
    case ChainId.ETHEREUM_GOERLI:
      return 'goerli'
    case ChainId.ETHEREUM_KOVAN:
      return 'kovan'
    case ChainId.MATIC_MAINNET:
      return 'matic'
    case ChainId.MATIC_MUMBAI:
      return 'mumbai'
  }
}

function buildUrn(protocol: string, contract: string, option: string): string {
  const version = contract.startsWith('0x') ? 'v2' : 'v1'
  return `urn:decentraland:${protocol}:collections-${version}:${contract}:${option}`
}

function validateSize(size: string = '1024'): size is ValidSize {
  if (!isValidSize(size)) throw new ServiceError('Invalid size')
  return true
}

function getFileHash(entity: Entity, fileName?: string): string {
  const hash = findHashForFile(entity, fileName)
  if (!hash) throw new ServiceError(`Hash not found for file ${fileName}`, 404)

  return hash
}

async function fetchEntity(client: SmartContentClient, urn: string): Promise<Entity> {
  const entities: Entity[] = await client.fetchEntitiesByPointers(EntityType.WEARABLE, [urn])
  if (!(entities && entities.length > 0 && entities[0].metadata)) throw new ServiceError('Entity not found', 404)

  return entities[0]
}

export function getBodyShapes(representations: WearableMetadataRepresentation[]): string[] {
  const bodyShapes = new Set<WearableBodyShape>()
  for (const representation of representations) {
    for (const bodyShape of representation.bodyShapes) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      bodyShapes.add(bodyShape.split(':').pop()!)
    }
  }
  return Array.from(bodyShapes)
}

const RARITIES_EMISSIONS = {
  common: 100000,
  uncommon: 10000,
  rare: 5000,
  epic: 1000,
  legendary: 100,
  mythic: 10,
  unique: 1
}
