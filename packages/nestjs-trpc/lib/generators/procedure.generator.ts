import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProcedureGeneratorMetadata } from '../interfaces/generator.interface';
import { ProcedureType } from '../trpc.enum';
import { Project, SourceFile, Node, SyntaxKind, Type, Writers, Symbol, InterfaceDeclaration } from 'ts-morph';
import { ImportsScanner } from '../scanners/imports.scanner';
import { StaticGenerator } from './static.generator';
import { TYPESCRIPT_APP_ROUTER_SOURCE_FILE } from './generator.constants';
import { ProcedureFactoryMetadata } from '../interfaces/factory.interface';
import { z } from 'zod';

@Injectable()
export class ProcedureGenerator {
  @Inject(ImportsScanner)
  private readonly importsScanner!: ImportsScanner;

  @Inject(StaticGenerator)
  private readonly staticGenerator!: StaticGenerator;

  @Inject(TYPESCRIPT_APP_ROUTER_SOURCE_FILE)
  private readonly appRouterSourceFile!: SourceFile;

  public generateProcedureString(
    procedure: ProcedureGeneratorMetadata,
  ): string {
    const { name, decorators } = procedure;
    const decorator = decorators.find(
      (decorator) =>
        decorator.name === ProcedureType.Mutation ||
        decorator.name === ProcedureType.Query,
    );

    if (!decorator) {
      return '';
    }

    const decoratorArgumentsArray = Object.entries(decorator.arguments)
      .map(([key, value]) => `.${key}(${value})`)
      .join('');

    return `${name}: publicProcedure${decoratorArgumentsArray}.${decorator.name.toLowerCase()}(async () => "PLACEHOLDER_DO_NOT_REMOVE" as any )`;
  }

  public flattenZodSchema(
    node: Node,
    sourceFile: SourceFile,
    project: Project,
    schema: string,
  ): string {
    const importsMap = this.importsScanner.buildSourceFileImportsMap(
      sourceFile,
      project,
    );
    if (Node.isIdentifier(node)) {
      const identifierName = node.getText();
      const identifierDeclaration =
        sourceFile.getVariableDeclaration(identifierName);

      if (identifierDeclaration != null) {
        const identifierInitializer = identifierDeclaration.getInitializer();

        if (identifierInitializer != null) {
          const identifierSchema = this.flattenZodSchema(
            identifierInitializer,
            sourceFile,
            project,
            identifierInitializer.getText(),
          );

          schema = schema.replace(identifierName, identifierSchema);
        }
      } else if (importsMap.has(identifierName)) {
        const importedIdentifier = importsMap.get(identifierName);

        if (importedIdentifier != null) {
          const { initializer } = importedIdentifier;
          const identifierSchema = this.flattenZodSchema(
            initializer,
            importedIdentifier.sourceFile,
            project,
            initializer.getText(),
          );

          schema = schema.replace(identifierName, identifierSchema);
        }
      }
    } else if (Node.isObjectLiteralExpression(node)) {
      for (const property of node.getProperties()) {
        if (Node.isPropertyAssignment(property)) {
          const propertyText = property.getText();
          const propertyInitializer = property.getInitializer();

          if (propertyInitializer != null) {
            schema = schema.replace(
              propertyText,
              this.flattenZodSchema(
                propertyInitializer,
                sourceFile,
                project,
                propertyText,
              ),
            );
          }
        }
      }
    } else if (Node.isArrayLiteralExpression(node)) {
      for (const element of node.getElements()) {
        const elementText = element.getText();
        schema = schema.replace(
          elementText,
          this.flattenZodSchema(element, sourceFile, project, elementText),
        );
      }
    } else if (Node.isCallExpression(node)) {
      const expression = node.getExpression();

      schema = node.getDescendantsOfKind(
        SyntaxKind.CallExpression
      ).reduce((prev, curr) => {
        return prev.replace(
          curr.getText(),
          this.flattenZodSchema(
            curr,
            sourceFile,
            project,
            curr.getText()
          )
        );
      }, schema);
      
      if (
        Node.isPropertyAccessExpression(expression) &&
        !expression.getText().startsWith('z')
      ) {
        const baseSchema = this.flattenZodSchema(
          expression,
          sourceFile,
          project,
          expression.getText(),
        );
        const propertyName = expression.getName();
        schema = schema.replace(
          expression.getText(),
          `${baseSchema}.${propertyName}`,
        );
      } else if (!expression.getText().startsWith('z')) {
        this.staticGenerator.addSchemaImports(
          this.appRouterSourceFile,
          [expression.getText()],
          importsMap,
        );
      }

      for (const arg of node.getArguments()) {
        const argText = arg.getText();
        schema = schema.replace(
          argText,
          this.flattenZodSchema(arg, sourceFile, project, argText),
        );
      }
    } else if (Node.isPropertyAccessExpression(node)) {
      schema = this.flattenZodSchema(
        node.getExpression(),
        sourceFile,
        project,
        node.getExpression().getText(),
      );
    }

    return schema;
  }

  public generateZodSchema(
    type: Type,
    sourceFile: SourceFile,
  ): string {
    let outputSchema = ""; 
    if (type.getSymbol()?.getName() === 'Promise') {
      return this.generateZodSchema(
        type.getTypeArguments()[0],
        sourceFile
      );
    }
    
    // Primitives
    if (type.isLiteral()) {
      outputSchema += `z.literal(${type.getLiteralValue()})`;
    } else if (type.isString()) {
      outputSchema += `z.string()`;
    } else if (type.isBoolean()) {
      outputSchema += `z.boolean()`;
    } else if (type.isNull()) {
      outputSchema += `z.null()`;
    } else if (type.isNumber()) {
      outputSchema += `z.number()`;
    } else if (type.isUndefined()) {
      outputSchema += `z.undefined()`;
    } else if (type.isArray()) {
      outputSchema += `z.array(${this.generateZodSchema(type.getArrayElementType()!, sourceFile)})`;
    } else if (type.isInterface() || type.isObject()) {
      if (type.getCallSignatures().length > 0) {
        return '';
      }

      let properties: Symbol[] = [];
      const decl = type.getSymbol()?.getDeclarations()?.[0] as InterfaceDeclaration;

      properties = type.getProperties();
      outputSchema += `z.object({`

      for (const prop of properties) {
        const propType = prop.getTypeAtLocation(decl);

        if (propType.isObject() && propType.getCallSignatures().length > 0) {
          continue;
        }

        outputSchema += `${prop.getName()}:` + this.generateZodSchema(
          prop.getTypeAtLocation(decl),
          sourceFile
        );
      }

      outputSchema += `})`
    } else if (type.isUnion()) {
      outputSchema += `z.union([`;
      for (const t of type.getUnionTypes()) {
          outputSchema += this.generateZodSchema(t, sourceFile);
      }
      outputSchema += `])`;
    } else if (type.isIntersection()) {
      const [first, ...rest] = type.getIntersectionTypes();

      outputSchema += `${this.generateZodSchema(first, sourceFile)}`;
      for (const t of rest) {
        outputSchema += `.and(${this.generateZodSchema(t, sourceFile)})`;
      }
    } else if (type.isVoid()) {
      outputSchema += `z.void()`;
    } else {
      outputSchema += `z.any()`;
    }

    return `${outputSchema},`;
  }
}
