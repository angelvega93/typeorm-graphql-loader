import {
  ASTNode,
  FieldNode,
  GraphQLResolveInfo,
  Kind,
  OperationDefinitionNode,
  SelectionNode,
  ValueNode
} from "graphql";
import { BaseEntity, Connection, SelectQueryBuilder } from "typeorm";
import { RelationMetadata } from "typeorm/metadata/RelationMetadata";
import { snakeCase } from "typeorm/util/StringUtils";
import { FeedNodeInfo, Hash, Selection } from "./types";

function parseLiteral(ast: ValueNode): any {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return parseFloat(ast.value);
    case Kind.OBJECT: {
      const value = Object.create(null);
      ast.fields.forEach(field => {
        value[field.name.value] = parseLiteral(field.value);
      });
      return value;
    }
    case Kind.LIST:
      return ast.values.map(parseLiteral);
    default:
      return null;
  }
}

const getSelections = (
  ast: OperationDefinitionNode
): ReadonlyArray<SelectionNode> => {
  if (
    ast &&
    ast.selectionSet &&
    ast.selectionSet.selections &&
    ast.selectionSet.selections.length
  ) {
    return ast.selectionSet.selections;
  }
  return [];
};

const isFragment = (ast: ASTNode) => {
  return ast.kind === "InlineFragment" || ast.kind === "FragmentSpread";
};

const getAST = (ast: ASTNode, info: GraphQLResolveInfo | FeedNodeInfo) => {
  if (ast.kind === "FragmentSpread") {
    const fragmentName = ast.name.value;
    return info.fragments[fragmentName];
  }
  return ast;
};

const flattenAST = (
  ast: ASTNode,
  info: GraphQLResolveInfo | FeedNodeInfo,
  obj: Hash<Selection> = {}
): Hash<Selection> => {
  return getSelections(ast as OperationDefinitionNode).reduce(
    (flattened, n) => {
      if (isFragment(n)) {
        flattened = flattenAST(getAST(n, info), info, flattened);
      } else {
        const node: FieldNode = n as FieldNode;
        const name = (node as FieldNode).name.value;
        if (flattened[name]) {
          Object.assign(
            flattened[name].children,
            flattenAST(node, info, flattened[name].children)
          );
        } else {
          flattened[name] = {
            arguments: node.arguments
              ? node.arguments
                  .map(({ name, value }) => ({
                    [name.value]: parseLiteral(value)
                  }))
                  .reduce((p, n) => ({ ...p, ...n }), {})
              : {},
            children: flattenAST(node, info)
          };
        }
      }
      return flattened;
    },
    obj
  );
};

export const graphqlFields = (
  info: GraphQLResolveInfo | FeedNodeInfo,
  obj: Hash<Selection> = {}
): Selection => {
  const fields = info.fieldNodes;
  //@ts-ignore
  return { children: fields.reduce((o, ast) => flattenAST(ast, info, o), obj) };
};

export const select = (
  model: Function | string,
  selection: Selection | null,
  connection: Connection,
  qb: SelectQueryBuilder<typeof BaseEntity>,
  alias: string,
  history?: Set<RelationMetadata>
): SelectQueryBuilder<typeof BaseEntity> => {
  const meta = connection.getMetadata(model);
  if (selection && selection.children) {
    // For some reason this causes the select to go into a loop and delete the actual fields I want
    // Results in all fields being selected, but that's not so bad
    const fields = meta.columns.filter(field => {
      return field.propertyName in selection.children!;
    });
    // always include the id
    if (!fields.find(field => field.propertyName === "id")) {
      qb = qb.addSelect(`${alias}.id`, `${alias}_id`);
    }
    fields.forEach(field => {
      qb = qb.addSelect(
        `${alias}.${field.propertyName}`,
        `${alias}_${snakeCase(field.propertyName)}`
      );
    });
    const relations = meta.relations;
    relations.forEach(relation => {
      if (relation.propertyName in selection.children!) {
        const childAlias = alias + "_" + relation.propertyName;
        qb = qb.leftJoin(alias + "." + relation.propertyName, childAlias);
        qb = select(
          relation.inverseEntityMetadata.target,
          selection.children![relation.propertyName],
          connection,
          qb,
          childAlias
        );
      }
    });
  } else if (selection === null) {
    history = history || new Set();
    const relations = meta.relations;
    relations.forEach(relation => {
      const childAlias = `${alias}_${relation.propertyName}`;
      if (relation.inverseRelation) {
        if (history!.has(relation.inverseRelation)) {
          qb = qb.addSelect(alias);
          return;
        }
        history!.add(relation);
        qb = qb.addFrom(
          relation.inverseRelation.entityMetadata.targetName,
          relation.inverseEntityMetadata.targetName
        );
        qb = qb.leftJoin(alias + "." + relation.propertyName, childAlias);
        qb = select(
          relation.inverseEntityMetadata.targetName,
          null,
          connection,
          qb,
          childAlias,
          history
        );
      } else {
        qb = qb.addSelect(`${alias}.${relation.propertyName}`, childAlias);
      }
    });
  }
  return qb;
};
