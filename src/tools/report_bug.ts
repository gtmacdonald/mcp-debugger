import { z } from 'zod';
import { saveReport } from '../db.js';

export const reportBugTool = {
    name: 'report_bug',
    description: 'Report a bug encountered during debugging',
    parameters: z.object({
        severity: z.enum(['low', 'medium', 'high', 'critical']),
        description: z.string(),
        context: z.record(z.any()).optional()
    }),
    handler: async (args: { severity: string; description: string; context?: Record<string, unknown> }) => {
        await saveReport(args.severity, args.description, args.context || {});
        return {
            content: [
                {
                    type: 'text',
                    text: `Bug report saved successfully.`
                }
            ]
        };
    }
};
