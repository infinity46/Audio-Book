import { InMemoryStorageProvider } from './in-memory-provider.js';
import { runStorageProviderContractTests } from './contract.js';

runStorageProviderContractTests('in-memory', () => new InMemoryStorageProvider());
