function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, expected) {
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "array") return Array.isArray(value);
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "null") return value === null;
  return typeof value === expected;
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (
    left && right
    && typeof left === "object" && typeof right === "object"
    && !Array.isArray(left) && !Array.isArray(right)
  ) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return deepEqual(leftKeys, rightKeys) && leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

export function validateSchema(schema, value) {
  const errors = [];
  const root = schema;

  function visit(currentSchema, currentValue, instancePath, activeRefs) {
    if (!currentSchema || typeof currentSchema !== "object" || Array.isArray(currentSchema)) {
      errors.push(`${instancePath}: schema must be an object`);
      return;
    }

    if (Object.hasOwn(currentSchema, "$ref")) {
      const reference = currentSchema.$ref;
      if (typeof reference !== "string" || !reference.startsWith("#/$defs/")) {
        errors.push(`${instancePath}: External or unsupported schema reference: ${String(reference)}`);
        return;
      }
      const definitionName = reference.slice("#/$defs/".length);
      if (!definitionName || definitionName.includes("/")) {
        errors.push(`${instancePath}: Unsupported local schema reference: ${reference}`);
        return;
      }
      const definition = root.$defs?.[definitionName];
      if (!definition) {
        errors.push(`${instancePath}: Missing schema definition: ${definitionName}`);
        return;
      }
      if (activeRefs.has(reference)) {
        errors.push(`${instancePath}: Recursive schema reference rejected: ${reference}`);
        return;
      }
      visit(definition, currentValue, instancePath, new Set([...activeRefs, reference]));
      return;
    }

    if (Array.isArray(currentSchema.oneOf)) {
      let matches = 0;
      for (const candidate of currentSchema.oneOf) {
        const errorStart = errors.length;
        visit(candidate, currentValue, instancePath, activeRefs);
        if (errors.length === errorStart) matches += 1;
        else errors.splice(errorStart);
      }
      if (matches !== 1) {
        errors.push(`${instancePath}: expected exactly one oneOf schema match, received ${matches}`);
      }
    }

    if (Object.hasOwn(currentSchema, "type")) {
      const expectedTypes = Array.isArray(currentSchema.type) ? currentSchema.type : [currentSchema.type];
      if (!expectedTypes.some((expected) => matchesType(currentValue, expected))) {
        errors.push(`${instancePath}: expected ${expectedTypes.join(" or ")}, received ${valueType(currentValue)}`);
        return;
      }
    }

    if (Object.hasOwn(currentSchema, "const") && !deepEqual(currentValue, currentSchema.const)) {
      errors.push(`${instancePath}: expected constant ${JSON.stringify(currentSchema.const)}`);
    }
    if (Array.isArray(currentSchema.enum)
      && !currentSchema.enum.some((candidate) => deepEqual(candidate, currentValue))) {
      errors.push(`${instancePath}: value is not in enum ${JSON.stringify(currentSchema.enum)}`);
    }
    if (typeof currentSchema.pattern === "string" && typeof currentValue === "string") {
      try {
        if (!new RegExp(currentSchema.pattern).test(currentValue)) {
          errors.push(`${instancePath}: string does not match pattern ${currentSchema.pattern}`);
        }
      } catch (error) {
        errors.push(`${instancePath}: invalid schema pattern: ${error.message}`);
      }
    }
    if (typeof currentSchema.minimum === "number"
      && typeof currentValue === "number"
      && currentValue < currentSchema.minimum) {
      errors.push(`${instancePath}: value is below minimum ${currentSchema.minimum}`);
    }
    if (typeof currentSchema.maximum === "number"
      && typeof currentValue === "number"
      && currentValue > currentSchema.maximum) {
      errors.push(`${instancePath}: value is above maximum ${currentSchema.maximum}`);
    }
    if (typeof currentSchema.minItems === "number"
      && Array.isArray(currentValue)
      && currentValue.length < currentSchema.minItems) {
      errors.push(`${instancePath}: array has fewer than ${currentSchema.minItems} items`);
    }
    if (typeof currentSchema.maxItems === "number"
      && Array.isArray(currentValue)
      && currentValue.length > currentSchema.maxItems) {
      errors.push(`${instancePath}: array has more than ${currentSchema.maxItems} items`);
    }

    if (currentValue !== null && typeof currentValue === "object" && !Array.isArray(currentValue)) {
      const properties = currentSchema.properties || {};
      for (const requiredKey of currentSchema.required || []) {
        if (!Object.hasOwn(currentValue, requiredKey)) {
          errors.push(`${instancePath}: missing required property ${requiredKey}`);
        }
      }
      for (const [key, propertyValue] of Object.entries(currentValue)) {
        if (Object.hasOwn(properties, key)) {
          visit(properties[key], propertyValue, `${instancePath}.${key}`, activeRefs);
        } else if (currentSchema.additionalProperties === false) {
          errors.push(`${instancePath}: additional property not allowed: ${key}`);
        } else if (
          currentSchema.additionalProperties
          && typeof currentSchema.additionalProperties === "object"
        ) {
          visit(
            currentSchema.additionalProperties,
            propertyValue,
            `${instancePath}.${key}`,
            activeRefs,
          );
        }
      }
    }

    if (Array.isArray(currentValue) && currentSchema.items) {
      currentValue.forEach((item, index) => {
        visit(currentSchema.items, item, `${instancePath}[${index}]`, activeRefs);
      });
    }
  }

  visit(schema, value, "$", new Set());
  return { valid: errors.length === 0, errors };
}
