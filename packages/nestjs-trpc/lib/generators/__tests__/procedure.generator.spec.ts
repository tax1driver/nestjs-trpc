import { Test, TestingModule } from '@nestjs/testing';
import { Project, ts } from 'ts-morph';
import {
  ProcedureGeneratorMetadata,
} from '../../interfaces/generator.interface';
import { ProcedureGenerator } from '../procedure.generator';
import { ImportsScanner } from '../../scanners/imports.scanner';
import { ScannerModule } from '../../scanners/scanner.module';
import { StaticGenerator } from '../static.generator';
import { TYPESCRIPT_APP_ROUTER_SOURCE_FILE } from '../generator.constants';
import { z } from 'zod';


describe('ProcedureGenerator', () => {
  let procedureGenerator: ProcedureGenerator;
  let project: Project;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ScannerModule],
      providers: [
        ProcedureGenerator,
        {
          provide: StaticGenerator,
          useValue: jest.fn(),
        },
        {
          provide: TYPESCRIPT_APP_ROUTER_SOURCE_FILE,
          useValue: jest.fn(),
        },
      ],
    }).compile();

    procedureGenerator = module.get<ProcedureGenerator>(ProcedureGenerator);
  });

  it('should be defined', () => {
    expect(procedureGenerator).toBeDefined();
  });

  describe('generateRoutersStringFromMetadata', () => {
    describe('for a query', () => {
      it('should generate router string from metadata', () => {
        const mockProcedure: ProcedureGeneratorMetadata = {
          name: 'testQuery',
          decorators: [{ name: 'Query', arguments: {} }],
        }

        const result = procedureGenerator.generateProcedureString(mockProcedure);

        expect(result).toBe(
          'testQuery: publicProcedure.query(async () => "PLACEHOLDER_DO_NOT_REMOVE" as any )'
        );
      });
    })

    describe('for a mutation', () => {
      it('should generate router string from metadata', () => {
        const mockProcedure: ProcedureGeneratorMetadata = {
          name: 'testMutation',
          decorators: [{ name: 'Mutation', arguments: {} }],
        }

        const result = procedureGenerator.generateProcedureString(mockProcedure);

        expect(result).toBe(
          'testMutation: publicProcedure.mutation(async () => "PLACEHOLDER_DO_NOT_REMOVE" as any )'
        );
      });
    });
  });

  describe('flattenZodSchema', () => {
    it('should correctly process chained zod function calls', () => {
      const project = new Project();

      const sourceFile = project.createSourceFile(
        `test.ts`,
        `
          const schema = z.object({
            chained: z.array(z.object({ example: z.string() })).optional(),
          });
        `, { overwrite: true });

      const schema = sourceFile.getVariableDeclaration('schema')?.getInitializer();

      const result = procedureGenerator.flattenZodSchema(
        schema as any,
        sourceFile as any,
        project as any,
        schema?.getText() as any
      );

      expect(result).toMatchSnapshot();
    });
  })
});