import {
    createNestedNavigationFromFolder,
    resolveManifest,
    type DocsPackageManifestInput,
} from '@vendure-io/docs-provider';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const file = (relativePath: string) => join(packageRoot, relativePath);

const manifestInput: DocsPackageManifestInput = {
    id: 'community-plugins',
    name: 'Community Plugins',
    version: '1.0.0',
    vendureVersion: 'v3',
    basePath: packageRoot,
    navigation: [
        {
            title: 'Reference',
            slug: 'reference',
            children: [
                {
                    title: 'Community Plugins',
                    slug: 'core-plugins',
                    file: file('docs/reference/core-plugins/index.mdx'),
                    children: createNestedNavigationFromFolder(
                        join(packageRoot, 'docs/reference/core-plugins'),
                        { extensions: ['.mdx'] },
                    ),
                },
                {
                    title: 'Pub/Sub Plugin',
                    slug: 'pub-sub-plugin',
                    children: createNestedNavigationFromFolder(
                        join(packageRoot, 'docs/reference/pub-sub-plugin'),
                        { extensions: ['.mdx'] },
                    ),
                },
            ],
        },
    ],
    github: {
        repository: 'vendurehq/community-plugins',
        branch: 'main',
        docsPath: 'docs',
    },
};

export const manifest = resolveManifest(manifestInput);
