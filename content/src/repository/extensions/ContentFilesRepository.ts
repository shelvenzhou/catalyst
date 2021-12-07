import { ContentFileHash, Timestamp } from 'dcl-catalyst-commons'
import { SQL } from 'sql-template-strings'
import { AppComponents } from 'src/types'
import { Database } from '../../repository/Database'
import { DeploymentId } from './DeploymentsRepository'

export class ContentFilesRepository {
  constructor(
    private readonly db: Database,
    private readonly components: Pick<AppComponents, 'database' | 'metrics' | 'staticConfigs'>
  ) {}

  findContentHashesNotBeingUsedAnymore(lastGarbageCollection: Timestamp): Promise<ContentFileHash[]> {
    return this.db.map(
      `
            SELECT content_files.content_hash
            FROM content_files
            INNER JOIN deployments ON content_files.deployment=id
            LEFT JOIN deployments AS dd ON deployments.deleter_deployment=dd.id
            WHERE dd.local_timestamp IS NULL OR dd.local_timestamp > to_timestamp($1 / 1000.0)
            GROUP BY content_files.content_hash
            HAVING bool_or(deployments.deleter_deployment IS NULL) = FALSE
            `,
      [lastGarbageCollection],
      (row) => row.content_hash
    )
  }

  async getContentFiles(deploymentIds: DeploymentId[]): Promise<Map<DeploymentId, DeploymentContent[]>> {
    if (deploymentIds.length === 0) {
      return new Map()
    }
    const queryResult = await this.db.any(
      'SELECT deployment, key, content_hash FROM content_files WHERE deployment IN ($1:list)',
      [deploymentIds]
    )
    const result: Map<DeploymentId, DeploymentContent[]> = new Map()
    queryResult.forEach((row) => {
      if (!result.has(row.deployment)) {
        result.set(row.deployment, [])
      }
      result.get(row.deployment)?.push({ key: row.key, hash: row.content_hash })
    })
    return result
  }

  async saveContentFiles(deploymentId: DeploymentId, content: Map<string, ContentFileHash>): Promise<void> {
    const query = SQL`INSERT INTO content_files (deployment, key, content_hash) VALUES`
    const contentEntries = Array.from(content.entries())
    contentEntries.map(([name, hash], index) => {
      if (index < contentEntries.length - 1) {
        query.append(SQL`(${deploymentId}, ${name}, ${hash}),`)
      } else {
        query.append(SQL`(${deploymentId}, ${name}, ${hash})`)
      }
    })

    await this.components.database.queryWithValues(query)
  }
}
