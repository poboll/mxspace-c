import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

export const RegistryModelsQuerySchema = z.object({
  providerId: z.string().min(1, 'providerId is required'),
})

export class RegistryModelsQueryDto extends createZodDto(
  RegistryModelsQuerySchema,
) {}

const reconcileFeatureSchema = z.enum([
  'summary',
  'insights',
  'translation',
  'translation-entries',
])

export const ReconcileAiSchema = z
  .object({
    features: z.array(reconcileFeatureSchema).optional(),
    force: z.boolean().optional(),
    rebuildSearch: z.boolean().optional(),
    targetLanguages: z.array(z.string()).optional(),
    translationEntryKeyPaths: z
      .array(
        z.enum([
          'category.name',
          'topic.name',
          'topic.introduce',
          'topic.description',
          'note.mood',
          'note.weather',
        ]),
      )
      .optional(),
  })
  .default({})

export class ReconcileAiDto extends createZodDto(ReconcileAiSchema) {}

export type RegistryModelsQueryInput = z.infer<typeof RegistryModelsQuerySchema>
export type ReconcileAiInput = z.infer<typeof ReconcileAiSchema>
