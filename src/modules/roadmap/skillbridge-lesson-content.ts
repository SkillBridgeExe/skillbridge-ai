export type LessonContentLicenseType =
  | 'skillbridge_original'
  | 'official_reference'
  | 'link_only';

export type LessonContentReusePolicy =
  | 'full_reuse_allowed'
  | 'summary_only'
  | 'link_only';

export interface LessonSectionContent {
  id: string;
  title: string;
  body: string;
  checklist: string[];
}

export interface LessonQuizQuestion {
  id: string;
  question: string;
  options: string[];
  correct_option_index: number;
  explanation: string;
}

export interface LessonExerciseContent {
  id: string;
  title: string;
  prompt: string;
  acceptance_criteria: string[];
  proof_of_completion: string;
}

export interface SkillBridgeLessonContent {
  skill_canonical: string;
  title: string;
  summary: string;
  license_type: LessonContentLicenseType;
  reuse_policy: LessonContentReusePolicy;
  source_resource_ids: string[];
  sections: LessonSectionContent[];
  quiz: LessonQuizQuestion[];
  exercises: LessonExerciseContent[];
}

export const SKILLBRIDGE_LESSON_SKILLS = [
  'react',
  'typescript',
  'javascript',
  'node_js',
  'dotnet',
  'java',
  'spring_boot',
  'python',
  'sql',
  'postgresql',
  'docker',
  'git',
  'rest_api',
  'html',
  'css',
  'english_proficiency',
  'communication',
  'cv_writing',
  'system_design',
  'llm_engineering',
] as const;

type SkillBridgeLessonSkill = (typeof SKILLBRIDGE_LESSON_SKILLS)[number];

interface LessonSectionBlueprint {
  id: string;
  title: string;
  body: string;
  checklist: string[];
}

interface LessonQuizBlueprint {
  id: string;
  question: string;
  options: string[];
  correct_option_index: number;
  explanation: string;
}

interface LessonExerciseBlueprint {
  id: string;
  title: string;
  prompt: string;
  acceptance_criteria: string[];
  proof_of_completion: string;
}

interface LessonBlueprint {
  title: string;
  summary: string;
  sections: [LessonSectionBlueprint, LessonSectionBlueprint];
  quiz: [LessonQuizBlueprint, LessonQuizBlueprint];
  exercise: LessonExerciseBlueprint;
}

const LESSON_BLUEPRINTS = {
  react: {
    title: 'React component fundamentals',
    summary:
      'Build a reliable React foundation by splitting UI into components, passing data with props, and managing local state only where interaction requires it.',
    sections: [
      {
        id: 'components-props',
        title: 'Components and props',
        body:
          'A React component should represent one focused part of the interface. Props carry data from a parent to a child so each component can render predictably without reaching into global state.',
        checklist: [
          'Create one parent component and two child components.',
          'Pass at least two props into a child component.',
          'Keep each component focused on one visible responsibility.',
        ],
      },
      {
        id: 'state-events',
        title: 'Local state and events',
        body:
          'Use local state for values that change because a user interacts with the page. Keep state close to the component that owns the interaction and update arrays or objects immutably.',
        checklist: [
          'Add a click or form event handler.',
          'Update state without mutating the existing value.',
          'Render a different UI state after the update.',
        ],
      },
    ],
    quiz: [
      {
        id: 'state-purpose',
        question: 'When should a React value usually be stored in local state?',
        options: [
          'When it changes because of user interaction',
          'Whenever it is received from props',
          'Only when it is a string',
          'Only when it comes from a server',
        ],
        correct_option_index: 0,
        explanation:
          'Local state is for UI data owned by the component, especially values changed by user interaction.',
      },
      {
        id: 'props-purpose',
        question: 'What is the safest way to pass display data from a parent to a child component?',
        options: ['Global variables', 'Props', 'Mutating the DOM', 'Local storage'],
        correct_option_index: 1,
        explanation:
          'Props keep parent-to-child data flow explicit and make components easier to test.',
      },
    ],
    exercise: {
      id: 'filtered-card-list',
      title: 'Build a filtered card list',
      prompt:
        'Create a small React page that renders a list of cards and lets the user filter the cards by a search input.',
      acceptance_criteria: [
        'The card list is rendered from an array.',
        'The search input updates state.',
        'The filtered result updates without a page reload.',
      ],
      proof_of_completion:
        'Screenshot the working filter and save a short note explaining component boundaries.',
    },
  },
  typescript: {
    title: 'TypeScript for safer application code',
    summary:
      'Use TypeScript to make data shapes explicit, catch common mistakes earlier, and document function contracts for real frontend and backend work.',
    sections: [
      {
        id: 'named-shapes',
        title: 'Types and interfaces',
        body:
          'Named types make API responses, form values, and component props easier to understand. They also let the compiler warn you when code expects fields that do not exist.',
        checklist: [
          'Create a type for a resource or user object.',
          'Use that type in at least one function parameter.',
          'Avoid using any for known shapes.',
        ],
      },
      {
        id: 'narrowing',
        title: 'Narrowing unknown data',
        body:
          'When data comes from outside the program, check it before treating it as trusted. Narrowing protects the rest of the code from nulls, bad variants, and incomplete payloads.',
        checklist: [
          'Guard nullable values before reading properties.',
          'Use union types for known variants.',
          'Handle the fallback branch explicitly.',
        ],
      },
    ],
    quiz: [
      {
        id: 'api-response',
        question: 'What is the main value of typing an API response?',
        options: [
          'It makes the network faster',
          'It documents and checks the expected shape',
          'It removes the need for runtime validation',
          'It automatically creates a database table',
        ],
        correct_option_index: 1,
        explanation:
          'Types document the expected shape and help the compiler catch mismatches in app code.',
      },
      {
        id: 'union-fallback',
        question: 'Why should a union type have an explicit fallback branch?',
        options: [
          'To hide compiler errors',
          'To handle every known variant safely',
          'To make all values strings',
          'To skip testing',
        ],
        correct_option_index: 1,
        explanation:
          'A fallback branch forces the code to acknowledge variants that need different handling.',
      },
    ],
    exercise: {
      id: 'resource-card-types',
      title: 'Type a resource card',
      prompt:
        'Define a TypeScript type for a learning resource and use it in a function that formats display badges.',
      acceptance_criteria: [
        'The type includes id, title, source type, and optional score fields.',
        'The formatting function handles missing optional values.',
        'No any type is used.',
      ],
      proof_of_completion:
        'Save the typed function and one example input/output pair.',
    },
  },
  javascript: {
    title: 'JavaScript fundamentals for app behavior',
    summary:
      'Practice the core JavaScript behaviors that appear in interviews and real apps: data transformation, functions, asynchronous work, and predictable error handling.',
    sections: [
      {
        id: 'data-functions',
        title: 'Data and functions',
        body:
          'Most application JavaScript transforms arrays, objects, and strings. Keep functions small, name the input and output clearly, and avoid changing data unexpectedly.',
        checklist: [
          'Write one pure function that transforms an array.',
          'Use map, filter, or reduce for a clear purpose.',
          'Avoid mutating the original input object or array.',
        ],
      },
      {
        id: 'async-errors',
        title: 'Async flow and errors',
        body:
          'Async code should make loading, success, and failure states visible. Promise chains and async functions both need a clear place where errors are caught and converted into useful messages.',
        checklist: [
          'Call one async function with await.',
          'Handle failure with try/catch or a rejected promise branch.',
          'Return a user-safe error message.',
        ],
      },
    ],
    quiz: [
      {
        id: 'pure-function',
        question: 'What makes a function easier to test?',
        options: [
          'It mutates global state',
          'It has clear inputs and returns a predictable output',
          'It logs every line',
          'It depends on random timing',
        ],
        correct_option_index: 1,
        explanation:
          'Clear inputs and outputs let you test the function without hidden setup.',
      },
      {
        id: 'async-error',
        question: 'What should async UI code do when a request fails?',
        options: [
          'Ignore the failure',
          'Show or return a clear failure state',
          'Retry forever without limit',
          'Delete the input data',
        ],
        correct_option_index: 1,
        explanation:
          'A visible failure state helps the user recover and helps developers debug the issue.',
      },
    ],
    exercise: {
      id: 'async-filter-flow',
      title: 'Build an async filter flow',
      prompt:
        'Create a function that loads a list of items, filters it by a query, and returns either filtered results or a safe error object.',
      acceptance_criteria: [
        'The filter logic does not mutate the original item list.',
        'The async function handles a failed load.',
        'The result shape is documented with an example.',
      ],
      proof_of_completion:
        'Save the function, one success example, and one failure example.',
    },
  },
  node_js: {
    title: 'Node.js API basics',
    summary:
      'Practice the shape of a small backend endpoint: request validation, service logic, and a predictable JSON response that frontend code can trust.',
    sections: [
      {
        id: 'routes-input',
        title: 'Routes and request data',
        body:
          'A backend route should receive input, validate the important fields, call a focused service function, and return a consistent response shape.',
        checklist: [
          'Define one GET route and one POST route.',
          'Validate required body fields before using them.',
          'Return errors with a clear message.',
        ],
      },
      {
        id: 'service-boundary',
        title: 'Service boundary',
        body:
          'Keep business logic outside the route handler so the logic can be tested without starting the HTTP server. The handler should translate HTTP into service calls.',
        checklist: [
          'Move business logic into a function or service.',
          'Write one success case and one error case.',
          'Keep route handlers short.',
        ],
      },
    ],
    quiz: [
      {
        id: 'service-test',
        question: 'Why should business logic usually live outside the route handler?',
        options: [
          'To make the handler harder to read',
          'To make the logic reusable and easier to test',
          'Because JSON requires it',
          'Because Node.js cannot run logic in routes',
        ],
        correct_option_index: 1,
        explanation:
          'A service boundary lets you test core behavior without coupling every test to HTTP.',
      },
      {
        id: 'validation',
        question: 'What should happen when required request data is missing?',
        options: [
          'Return a clear validation error',
          'Save an empty record silently',
          'Crash the server process',
          'Pretend the request succeeded',
        ],
        correct_option_index: 0,
        explanation:
          'Validation errors should be explicit so clients can correct the request.',
      },
    ],
    exercise: {
      id: 'task-endpoint',
      title: 'Create a task endpoint',
      prompt:
        'Build a POST /tasks endpoint that accepts a title, validates it, and returns a created task object.',
      acceptance_criteria: [
        'Empty titles return a validation error.',
        'Valid titles return an id, title, and createdAt timestamp.',
        'The creation logic is testable outside the route handler.',
      ],
      proof_of_completion:
        'Save the request/response examples and one passing service test.',
    },
  },
  dotnet: {
    title: '.NET Web API fundamentals',
    summary:
      'Learn the shape of a maintainable .NET API by separating controllers, services, DTOs, and validation so each layer has a clear responsibility.',
    sections: [
      {
        id: 'controller-dto',
        title: 'Controllers and DTOs',
        body:
          'A controller should expose the HTTP contract while DTOs describe the request and response shape. Keeping entity models out of public responses reduces accidental data leaks.',
        checklist: [
          'Create one request DTO and one response DTO.',
          'Return a consistent status code for success.',
          'Avoid returning persistence entities directly.',
        ],
      },
      {
        id: 'service-validation',
        title: 'Services and validation',
        body:
          'Service classes hold business behavior that can be tested without HTTP. Validate required inputs before the service changes state or calls a repository.',
        checklist: [
          'Move business logic into a service method.',
          'Add validation for required fields.',
          'Write one unit test for the service method.',
        ],
      },
    ],
    quiz: [
      {
        id: 'dto-purpose',
        question: 'Why use DTOs in a Web API?',
        options: [
          'To describe the public request and response shape',
          'To make the database slower',
          'To remove all validation',
          'To force every field to be public',
        ],
        correct_option_index: 0,
        explanation:
          'DTOs keep the API contract explicit and separate from internal persistence details.',
      },
      {
        id: 'service-purpose',
        question: 'What is a good reason to put logic in a service class?',
        options: [
          'It can be tested without starting HTTP',
          'It hides all compiler errors',
          'It makes controllers larger',
          'It replaces status codes',
        ],
        correct_option_index: 0,
        explanation:
          'Service logic can be tested directly and reused by multiple entry points.',
      },
    ],
    exercise: {
      id: 'todo-api',
      title: 'Design a small todo API',
      prompt:
        'Sketch or implement a .NET endpoint that creates a todo item using a request DTO, service method, and response DTO.',
      acceptance_criteria: [
        'The request DTO contains only fields the client may send.',
        'The service validates an empty title.',
        'The response DTO hides internal persistence fields.',
      ],
      proof_of_completion:
        'Save the DTOs, service method, and a short explanation of the layer boundaries.',
    },
  },
  java: {
    title: 'Java application fundamentals',
    summary:
      'Build confidence with Java classes, collections, exceptions, and small service methods that can be tested and explained in interviews.',
    sections: [
      {
        id: 'classes-methods',
        title: 'Classes and methods',
        body:
          'A Java class should group related data and behavior. Method names should reveal the action, and parameters should make the required input obvious.',
        checklist: [
          'Create one class with private fields.',
          'Add a constructor or factory method.',
          'Write a method that returns a calculated value.',
        ],
      },
      {
        id: 'collections-errors',
        title: 'Collections and exceptions',
        body:
          'Collections help model lists and maps of domain data. Exceptions should be used for invalid states that the caller needs to handle or prevent.',
        checklist: [
          'Use a List or Map for a real lookup task.',
          'Handle the empty or missing case clearly.',
          'Write one test for a valid and invalid input.',
        ],
      },
    ],
    quiz: [
      {
        id: 'encapsulation',
        question: 'Why are fields often private in Java classes?',
        options: [
          'To control how state is read or changed',
          'To make the object unusable',
          'To disable constructors',
          'To remove the need for tests',
        ],
        correct_option_index: 0,
        explanation:
          'Private fields protect state and let methods enforce rules around changes.',
      },
      {
        id: 'collection-choice',
        question: 'When is a Map useful?',
        options: [
          'When looking up values by a key',
          'When every value must be ignored',
          'Only for printing strings',
          'Only inside comments',
        ],
        correct_option_index: 0,
        explanation:
          'A Map is useful when a key should quickly locate a related value.',
      },
    ],
    exercise: {
      id: 'grade-service',
      title: 'Create a grade service',
      prompt:
        'Write a small Java service that receives scores, validates them, and returns a letter grade summary.',
      acceptance_criteria: [
        'Scores outside 0-100 are rejected.',
        'The service returns a clear grade for valid scores.',
        'At least two cases are covered by tests or examples.',
      ],
      proof_of_completion:
        'Save the service code and examples for one valid score and one invalid score.',
    },
  },
  spring_boot: {
    title: 'Spring Boot API structure',
    summary:
      'Practice a Spring Boot endpoint with controller, service, validation, and repository boundaries so the application stays testable as it grows.',
    sections: [
      {
        id: 'controller-service',
        title: 'Controller to service flow',
        body:
          'A Spring controller should receive HTTP input and delegate business rules to a service. This keeps endpoint code small and makes service behavior easier to test.',
        checklist: [
          'Create one controller method for a simple resource.',
          'Call a service from the controller.',
          'Return a response DTO instead of a raw internal object.',
        ],
      },
      {
        id: 'validation-errors',
        title: 'Validation and error responses',
        body:
          'Validation annotations and explicit error handling help clients understand what went wrong. The API should avoid exposing stack traces or ambiguous failure messages.',
        checklist: [
          'Mark at least one request field as required.',
          'Return a clear message for invalid input.',
          'Document the success and failure response shapes.',
        ],
      },
    ],
    quiz: [
      {
        id: 'controller-role',
        question: 'What is the controller mainly responsible for?',
        options: [
          'Handling HTTP input and output',
          'Storing every database row in memory',
          'Replacing the service layer',
          'Writing frontend CSS',
        ],
        correct_option_index: 0,
        explanation:
          'The controller translates HTTP requests into application operations and responses.',
      },
      {
        id: 'validation-role',
        question: 'Why validate request DTOs?',
        options: [
          'To reject bad input before business logic runs',
          'To slow every query',
          'To remove all response bodies',
          'To avoid naming fields',
        ],
        correct_option_index: 0,
        explanation:
          'Validation catches missing or invalid client input at the API boundary.',
      },
    ],
    exercise: {
      id: 'book-endpoint',
      title: 'Build a book creation endpoint',
      prompt:
        'Design a Spring Boot endpoint that creates a book record through a controller, request DTO, service, and response DTO.',
      acceptance_criteria: [
        'The request title is required.',
        'The controller delegates creation to a service.',
        'The response contains only client-safe fields.',
      ],
      proof_of_completion:
        'Save the endpoint sketch or code and one success plus one validation failure example.',
    },
  },
  python: {
    title: 'Python scripting and service logic',
    summary:
      'Use Python to write small, readable functions for data cleaning, file-safe transformations, and service logic that can be tested without heavy setup.',
    sections: [
      {
        id: 'functions-data',
        title: 'Readable functions',
        body:
          'Python functions should do one thing clearly. Use descriptive names, simple parameters, and return values that are easy to assert in tests.',
        checklist: [
          'Write one function with a clear input and output.',
          'Use list or dictionary operations intentionally.',
          'Add one example call that documents behavior.',
        ],
      },
      {
        id: 'errors-tests',
        title: 'Errors and tests',
        body:
          'Good Python code handles invalid input before it reaches deeper logic. A small test set can document normal, empty, and invalid cases.',
        checklist: [
          'Validate the shape or type of incoming data.',
          'Return or raise a clear error for invalid input.',
          'Cover one success and one failure case.',
        ],
      },
    ],
    quiz: [
      {
        id: 'function-design',
        question: 'What makes a Python function easy to test?',
        options: [
          'Clear inputs and a predictable output',
          'Hidden global state',
          'Printing instead of returning',
          'Changing files in every test',
        ],
        correct_option_index: 0,
        explanation:
          'Tests are simpler when behavior is expressed through inputs and return values.',
      },
      {
        id: 'invalid-input',
        question: 'What should happen when a function receives invalid input?',
        options: [
          'Handle it with a clear error path',
          'Continue silently with bad data',
          'Delete unrelated files',
          'Return random output',
        ],
        correct_option_index: 0,
        explanation:
          'Explicit errors make failures easier to diagnose and safer to recover from.',
      },
    ],
    exercise: {
      id: 'clean-cv-skills',
      title: 'Clean a skill list',
      prompt:
        'Write a Python function that receives raw skill strings, trims them, removes duplicates, and returns normalized display values.',
      acceptance_criteria: [
        'Whitespace-only values are ignored.',
        'Duplicate skills are removed case-insensitively.',
        'The original input list is not mutated.',
      ],
      proof_of_completion:
        'Save the function and examples for messy input, empty input, and duplicate input.',
    },
  },
  sql: {
    title: 'SQL query basics for application data',
    summary:
      'Practice selecting, filtering, joining, and explaining relational data in the way backend tasks and technical interviews usually require.',
    sections: [
      {
        id: 'select-filter',
        title: 'Select and filter',
        body:
          'Start every query by being clear about the table, the columns needed, and the filter that narrows the result to the user story.',
        checklist: [
          'Select only needed columns.',
          'Use WHERE for a specific condition.',
          'Sort results when order matters.',
        ],
      },
      {
        id: 'join-related',
        title: 'Join related tables',
        body:
          'A join combines rows from related tables. Use explicit join conditions so the relationship is readable and accidental cross joins are avoided.',
        checklist: [
          'Identify the foreign key relationship.',
          'Use an explicit JOIN clause.',
          'Explain why the join is needed.',
        ],
      },
    ],
    quiz: [
      {
        id: 'where-clause',
        question: 'What does a WHERE clause do?',
        options: [
          'Filters rows by a condition',
          'Creates a new table automatically',
          'Deletes duplicate databases',
          'Changes the database password',
        ],
        correct_option_index: 0,
        explanation:
          'WHERE narrows the returned rows to records that satisfy the condition.',
      },
      {
        id: 'join-purpose',
        question: 'Why use a JOIN?',
        options: [
          'To combine related rows from different tables',
          'To rename every table',
          'To erase old records',
          'To disable indexes',
        ],
        correct_option_index: 0,
        explanation:
          'JOIN connects tables through a relationship such as a foreign key.',
      },
    ],
    exercise: {
      id: 'user-orders',
      title: 'Query user orders',
      prompt:
        'Write a query that returns each user name with their latest order date from users and orders tables.',
      acceptance_criteria: [
        'The query joins users to orders.',
        'The result includes user name and latest order date.',
        'The query groups or ranks orders correctly.',
      ],
      proof_of_completion:
        'Save the SQL query and a short explanation of the join and aggregation.',
    },
  },
  postgresql: {
    title: 'PostgreSQL practical querying',
    summary:
      'Learn PostgreSQL features commonly used in application work: schema constraints, indexes, JSON fields, and explainable query performance.',
    sections: [
      {
        id: 'constraints-indexes',
        title: 'Constraints and indexes',
        body:
          'Constraints protect data correctness while indexes help common lookups stay fast. Choose both based on the rules and access patterns of the application.',
        checklist: [
          'Add a NOT NULL or UNIQUE rule to a table design.',
          'Identify one lookup that deserves an index.',
          'Explain what the index is meant to speed up.',
        ],
      },
      {
        id: 'json-queries',
        title: 'JSON and structured fields',
        body:
          'PostgreSQL can store structured JSON data, but it should not replace relational design for every relationship. Use JSON when the shape is flexible and queries are limited.',
        checklist: [
          'Describe one field that fits JSON storage.',
          'Describe one relationship that should stay relational.',
          'Write or sketch a query that reads a JSON property.',
        ],
      },
    ],
    quiz: [
      {
        id: 'constraint-purpose',
        question: 'What is the purpose of a database constraint?',
        options: [
          'To enforce a data rule',
          'To make every query slower',
          'To hide all tables',
          'To replace application code entirely',
        ],
        correct_option_index: 0,
        explanation:
          'Constraints keep invalid data from being stored even if application code has a bug.',
      },
      {
        id: 'index-purpose',
        question: 'What is a good reason to add an index?',
        options: [
          'A column is used often in filtering or lookup',
          'Every column needs one by default',
          'The table has no rows',
          'The query should return random data',
        ],
        correct_option_index: 0,
        explanation:
          'Indexes help when the database repeatedly searches or sorts by the indexed data.',
      },
    ],
    exercise: {
      id: 'profile-schema',
      title: 'Design a profile table',
      prompt:
        'Design a PostgreSQL table for user profiles with constraints, one useful index, and one optional JSON metadata field.',
      acceptance_criteria: [
        'The design includes at least two constraints.',
        'The index is tied to a realistic query.',
        'The JSON field is justified and not used for core relationships.',
      ],
      proof_of_completion:
        'Save the CREATE TABLE sketch and explain each constraint and index.',
    },
  },
  docker: {
    title: 'Docker fundamentals for portfolio projects',
    summary:
      'Learn the minimum Docker workflow needed to package a small app and explain images, containers, environment variables, and logs in a portfolio or interview.',
    sections: [
      {
        id: 'image-container',
        title: 'Images and containers',
        body:
          'An image is the packaged blueprint of an app. A container is a running instance of that image with its own process and environment.',
        checklist: [
          'Explain the difference between an image and a container.',
          'Build an image from a Dockerfile.',
          'Run a container and inspect its logs.',
        ],
      },
      {
        id: 'dockerfile-env',
        title: 'Dockerfile and environment',
        body:
          'A Dockerfile should install only what the app needs, copy the right files, expose the expected port, and allow configuration through environment variables.',
        checklist: [
          'Write a Dockerfile with a clear base image.',
          'Pass one configuration value through an environment variable.',
          'Document the build and run commands.',
        ],
      },
    ],
    quiz: [
      {
        id: 'container',
        question: 'What is a Docker container?',
        options: [
          'A running instance of an image',
          'A Git branch',
          'A database migration',
          'A CSS bundle',
        ],
        correct_option_index: 0,
        explanation:
          'A container runs from an image and contains the app process plus its runtime environment.',
      },
      {
        id: 'env-config',
        question: 'Why pass configuration through environment variables?',
        options: [
          'So the same image can run with different settings',
          'So the image cannot start',
          'So source code disappears',
          'So logs are disabled',
        ],
        correct_option_index: 0,
        explanation:
          'Environment variables let deployment settings change without rebuilding the image.',
      },
    ],
    exercise: {
      id: 'containerize-api',
      title: 'Containerize a small API',
      prompt:
        'Write a Dockerfile for a small API, build the image, and run it locally with an environment variable.',
      acceptance_criteria: [
        'The image builds successfully.',
        'The container starts without crashing.',
        'The app reads at least one environment variable.',
      ],
      proof_of_completion:
        'Save the Dockerfile and a screenshot or terminal log of the running container.',
    },
  },
  git: {
    title: 'Git workflow for collaborative delivery',
    summary:
      'Practice a branch-based workflow so your project history shows clear, reviewable progress and you can recover confidently when changes go wrong.',
    sections: [
      {
        id: 'branch-commit',
        title: 'Branches and commits',
        body:
          'A branch isolates work while commits record meaningful checkpoints. Good commit history makes collaboration and review easier.',
        checklist: [
          'Create a feature branch.',
          'Make two focused commits.',
          'Write commit messages that describe the change.',
        ],
      },
      {
        id: 'review-merge',
        title: 'Review and merge readiness',
        body:
          'Before merging, inspect the diff, run verification, and describe what changed. A clear review packet reduces back-and-forth and protects unrelated work.',
        checklist: [
          'Review the diff before sharing it.',
          'Run the relevant tests or build command.',
          'Write a summary with changes and verification.',
        ],
      },
    ],
    quiz: [
      {
        id: 'feature-branch',
        question: 'Why use a feature branch?',
        options: [
          'To isolate work before merging it',
          'To delete project history',
          'To make tests unnecessary',
          'To store passwords',
        ],
        correct_option_index: 0,
        explanation:
          'A feature branch keeps unfinished work separate from the main branch until it is ready.',
      },
      {
        id: 'diff-review',
        question: 'Why review your diff before asking for review?',
        options: [
          'To catch unrelated or accidental changes',
          'To hide the implementation',
          'To remove every test',
          'To make the branch impossible to merge',
        ],
        correct_option_index: 0,
        explanation:
          'A diff review helps catch accidental edits and makes the change easier to explain.',
      },
    ],
    exercise: {
      id: 'reviewable-branch',
      title: 'Prepare a reviewable branch',
      prompt:
        'Create a feature branch, make a small change, commit it, and write a short pull request summary.',
      acceptance_criteria: [
        'The branch name describes the task.',
        'The commit is focused.',
        'The summary includes what changed and how it was tested.',
      ],
      proof_of_completion:
        'Save the branch name, commit hash, and pull request summary draft.',
    },
  },
  rest_api: {
    title: 'REST API design essentials',
    summary:
      'Learn how to design simple REST endpoints with clear resources, request validation, status codes, and response shapes that frontend clients can use predictably.',
    sections: [
      {
        id: 'resources-methods',
        title: 'Resources and methods',
        body:
          'A REST API should model meaningful resources and use HTTP methods consistently. Endpoint names should describe nouns, while methods describe the action.',
        checklist: [
          'Name one resource collection with a plural noun.',
          'Map GET, POST, PATCH, and DELETE to clear actions.',
          'Avoid putting verbs into every URL path.',
        ],
      },
      {
        id: 'status-errors',
        title: 'Status codes and errors',
        body:
          'Status codes should match the outcome, and error bodies should explain what the client can fix. Consistent envelopes make frontend handling simpler.',
        checklist: [
          'Choose success and failure status codes for one endpoint.',
          'Design a consistent error body.',
          'Include validation details for bad input.',
        ],
      },
    ],
    quiz: [
      {
        id: 'resource-url',
        question: 'What should a REST URL usually represent?',
        options: [
          'A resource',
          'A random sentence',
          'Only a database password',
          'A CSS selector',
        ],
        correct_option_index: 0,
        explanation:
          'REST URLs usually identify resources, while HTTP methods describe actions.',
      },
      {
        id: 'bad-request',
        question: 'What status code family is used for client input mistakes?',
        options: ['4xx', '1xx only', '3xx only', 'Every request should be 200'],
        correct_option_index: 0,
        explanation:
          '4xx responses describe client-side request problems such as validation errors.',
      },
    ],
    exercise: {
      id: 'tasks-api-contract',
      title: 'Design a tasks API contract',
      prompt:
        'Define endpoints for listing, creating, updating, and deleting tasks, including response shapes and validation errors.',
      acceptance_criteria: [
        'Each endpoint uses a resource-oriented path.',
        'Success and error status codes are listed.',
        'The create request has at least one validation rule.',
      ],
      proof_of_completion:
        'Save the API contract table and one example request/response pair.',
    },
  },
  html: {
    title: 'HTML structure and accessibility basics',
    summary:
      'Build semantic HTML that gives pages a meaningful structure for users, assistive technology, search, and maintainable styling.',
    sections: [
      {
        id: 'semantic-layout',
        title: 'Semantic page structure',
        body:
          'Semantic elements such as header, main, section, nav, and button communicate purpose. Good structure helps both people and tools understand the page.',
        checklist: [
          'Use one main element for primary content.',
          'Choose button for actions and anchor for navigation.',
          'Keep heading levels in logical order.',
        ],
      },
      {
        id: 'forms-accessibility',
        title: 'Forms and accessible labels',
        body:
          'Inputs need labels, helpful error text, and predictable focus behavior. A form should be usable from the keyboard and understandable without placeholder-only instructions.',
        checklist: [
          'Connect each input to a visible label.',
          'Add helpful text for an invalid field.',
          'Test the form with keyboard tab navigation.',
        ],
      },
    ],
    quiz: [
      {
        id: 'button-anchor',
        question: 'When should you use a button instead of an anchor?',
        options: [
          'When the element performs an action on the page',
          'When navigating to another URL',
          'Only when text is long',
          'Never',
        ],
        correct_option_index: 0,
        explanation:
          'Buttons perform actions, while anchors navigate to destinations.',
      },
      {
        id: 'label-purpose',
        question: 'Why should form inputs have labels?',
        options: [
          'So users and assistive technology understand the input',
          'So CSS stops working',
          'So validation is impossible',
          'So the input cannot receive focus',
        ],
        correct_option_index: 0,
        explanation:
          'Labels communicate the purpose of an input and improve accessibility.',
      },
    ],
    exercise: {
      id: 'accessible-login-form',
      title: 'Build an accessible login form',
      prompt:
        'Create the HTML structure for a login form with labels, error text, and semantic layout regions.',
      acceptance_criteria: [
        'Each input has a visible label.',
        'The submit control is a button.',
        'The page uses main and section or form semantics correctly.',
      ],
      proof_of_completion:
        'Save the HTML snippet and a short note describing keyboard navigation behavior.',
    },
  },
  css: {
    title: 'CSS layout and responsive styling',
    summary:
      'Practice CSS fundamentals that matter in product UI: box model, flex or grid layout, responsive constraints, spacing, and readable state styling.',
    sections: [
      {
        id: 'box-layout',
        title: 'Box model and spacing',
        body:
          'Every element occupies a box. Spacing, borders, and sizing should be predictable so components do not jump or overlap when content changes.',
        checklist: [
          'Set width or max-width where content needs a boundary.',
          'Use padding for internal space and margin or gap between items.',
          'Check that long text wraps without breaking the layout.',
        ],
      },
      {
        id: 'responsive-grid',
        title: 'Responsive flex and grid',
        body:
          'Flexbox and grid help content adapt across screen sizes. Choose flex for one-dimensional alignment and grid when rows and columns both matter.',
        checklist: [
          'Build one flex row that wraps on small screens.',
          'Build one grid that changes column count responsively.',
          'Add a visible hover or focus state for interactive elements.',
        ],
      },
    ],
    quiz: [
      {
        id: 'gap-purpose',
        question: 'What is gap useful for in flex or grid layouts?',
        options: [
          'Consistent space between child items',
          'Changing text into images',
          'Removing all padding',
          'Disabling wrapping',
        ],
        correct_option_index: 0,
        explanation:
          'gap creates consistent spacing between layout children without extra margin rules.',
      },
      {
        id: 'grid-use',
        question: 'When is CSS grid often a good choice?',
        options: [
          'When controlling rows and columns together',
          'Only for changing font family',
          'Only for inline text',
          'When no layout is needed',
        ],
        correct_option_index: 0,
        explanation:
          'Grid is strong for two-dimensional layouts with rows and columns.',
      },
    ],
    exercise: {
      id: 'responsive-card-grid',
      title: 'Build a responsive card grid',
      prompt:
        'Create CSS for a card grid that works on mobile and desktop without text overlap or layout jumps.',
      acceptance_criteria: [
        'The grid has one column on narrow screens and multiple columns on wider screens.',
        'Cards keep consistent padding and gap.',
        'Long titles wrap cleanly inside their card.',
      ],
      proof_of_completion:
        'Save the CSS and screenshots or notes for mobile and desktop widths.',
    },
  },
  english_proficiency: {
    title: 'English interview communication',
    summary:
      'Practice clear English interview answers using structure, concise vocabulary, and evidence so your spoken response sounds prepared without feeling memorized.',
    sections: [
      {
        id: 'answer-structure',
        title: 'Structure a STAR answer',
        body:
          'A strong interview answer gives context, your responsibility, your action, and the result. STAR keeps the answer organized when speaking under pressure.',
        checklist: [
          'Write one answer with Situation, Task, Action, and Result.',
          'Keep the answer under two minutes.',
          'End with one concrete impact or lesson learned.',
        ],
      },
      {
        id: 'spoken-clarity',
        title: 'Speak clearly and naturally',
        body:
          'Good interview English is not about complex words. It is about clear pacing, direct verbs, and enough detail for the interviewer to trust your experience.',
        checklist: [
          'Replace vague words with specific action verbs.',
          'Practice the answer aloud once without reading.',
          'Record one version and note one improvement.',
        ],
      },
    ],
    quiz: [
      {
        id: 'star-order',
        question: 'What does STAR help you organize?',
        options: [
          'Situation, Task, Action, and Result',
          'Salary, Team, Age, and Role',
          'Server, Token, API, and Route',
          'Style, Theme, Animation, and Render',
        ],
        correct_option_index: 0,
        explanation:
          'STAR is a simple structure for evidence-based interview answers.',
      },
      {
        id: 'clear-answer',
        question: 'What usually improves spoken interview clarity?',
        options: [
          'Short direct sentences with concrete evidence',
          'Long memorized paragraphs',
          'Avoiding examples',
          'Using unclear buzzwords',
        ],
        correct_option_index: 0,
        explanation:
          'Direct language and concrete evidence make answers easier to follow.',
      },
    ],
    exercise: {
      id: 'record-star-answer',
      title: 'Record a STAR interview answer',
      prompt:
        'Prepare and record a 90-120 second answer about a project, challenge, or teamwork experience using STAR.',
      acceptance_criteria: [
        'The answer includes all four STAR parts.',
        'The answer is spoken in English for 90-120 seconds.',
        'The final sentence includes impact, evidence, or a lesson learned.',
      ],
      proof_of_completion:
        'Save the transcript or recording note and one self-correction for the next attempt.',
    },
  },
  communication: {
    title: 'Technical communication for engineers',
    summary:
      'Practice explaining technical decisions, blockers, and trade-offs in a way that teammates, mentors, and interviewers can understand quickly.',
    sections: [
      {
        id: 'explain-context',
        title: 'Explain context before details',
        body:
          'Start with the user goal or technical problem before jumping into implementation. Context helps listeners understand why your details matter.',
        checklist: [
          'Summarize the problem in one sentence.',
          'Name the audience for the explanation.',
          'Choose two details that support the main point.',
        ],
      },
      {
        id: 'tradeoffs-blockers',
        title: 'Describe trade-offs and blockers',
        body:
          'Strong technical communication is honest about constraints. Explain what you tried, what changed, and what decision you recommend next.',
        checklist: [
          'State one trade-off between two options.',
          'Describe one blocker without blame.',
          'End with a specific next action.',
        ],
      },
    ],
    quiz: [
      {
        id: 'context-first',
        question: 'Why explain context before implementation detail?',
        options: [
          'It helps the audience understand why the detail matters',
          'It makes the answer longer for no reason',
          'It hides the problem',
          'It replaces all evidence',
        ],
        correct_option_index: 0,
        explanation:
          'Context gives the listener a frame for judging the technical details.',
      },
      {
        id: 'blocker-update',
        question: 'What makes a blocker update useful?',
        options: [
          'Problem, impact, what was tried, and next action',
          'Only saying it is impossible',
          'Blaming another person',
          'Removing all deadlines',
        ],
        correct_option_index: 0,
        explanation:
          'A useful blocker update helps the team decide what to do next.',
      },
    ],
    exercise: {
      id: 'technical-update',
      title: 'Write a technical status update',
      prompt:
        'Write a short update explaining a technical problem, your current approach, one trade-off, and the next action.',
      acceptance_criteria: [
        'The first sentence gives context.',
        'The update includes one trade-off or risk.',
        'The final sentence asks for or states a next action.',
      ],
      proof_of_completion:
        'Save the update and one revised version that is shorter and clearer.',
    },
  },
  cv_writing: {
    title: 'CV writing with evidence',
    summary:
      'Turn experience into honest CV bullets that show action, scope, tools, and impact without inventing metrics or copying generic templates.',
    sections: [
      {
        id: 'bullet-anatomy',
        title: 'Build evidence-based bullets',
        body:
          'A strong bullet usually names the action, the object of the work, the tool or method, and the result. If no metric exists, use concrete scope or outcome instead.',
        checklist: [
          'Start one bullet with a strong action verb.',
          'Name the technology, domain, or artifact involved.',
          'Add impact, scope, or outcome without inventing numbers.',
        ],
      },
      {
        id: 'target-role-match',
        title: 'Match bullets to the target role',
        body:
          'CV writing is selective. Emphasize bullets that prove the skills in the job description and remove detail that distracts from the target role.',
        checklist: [
          'Mark two job requirements from the JD.',
          'Map each requirement to one bullet or project.',
          'Rewrite one bullet to make the match obvious.',
        ],
      },
    ],
    quiz: [
      {
        id: 'good-bullet',
        question: 'What should a strong CV bullet usually include?',
        options: [
          'Action, scope, tool or method, and result',
          'Only a list of buzzwords',
          'A made-up metric',
          'A paragraph with no verb',
        ],
        correct_option_index: 0,
        explanation:
          'Evidence-based bullets show what you did and why it mattered.',
      },
      {
        id: 'metric-honesty',
        question: 'What should you do if you do not have a real metric?',
        options: [
          'Use concrete scope or outcome instead',
          'Invent a percentage',
          'Delete the whole experience',
          'Write only adjectives',
        ],
        correct_option_index: 0,
        explanation:
          'Concrete scope is honest and more useful than a fabricated number.',
      },
    ],
    exercise: {
      id: 'rewrite-three-bullets',
      title: 'Rewrite three CV bullets',
      prompt:
        'Rewrite three raw experience bullets so they each show action, evidence, and target-role relevance.',
      acceptance_criteria: [
        'Each bullet starts with a strong action verb.',
        'Each bullet includes a tool, artifact, scope, or outcome.',
        'No bullet invents unverifiable numbers.',
      ],
      proof_of_completion:
        'Save the before/after bullets and mark which JD requirement each bullet supports.',
    },
  },
  system_design: {
    title: 'System design interview foundations',
    summary:
      'Learn a practical system design answer flow: clarify requirements, define APIs and data, identify bottlenecks, and explain trade-offs honestly.',
    sections: [
      {
        id: 'requirements-scope',
        title: 'Clarify requirements and scope',
        body:
          'Before drawing architecture, define what the system must do, who uses it, and which constraints matter most. Good scope prevents overbuilding the answer.',
        checklist: [
          'List functional and non-functional requirements separately.',
          'Name one assumption and one out-of-scope item.',
          'Estimate the most important scale or latency constraint.',
        ],
      },
      {
        id: 'architecture-tradeoffs',
        title: 'Architecture and trade-offs',
        body:
          'A system design answer should connect components to requirements. Every major choice has a trade-off, such as consistency versus availability or speed versus cost.',
        checklist: [
          'Draw or describe the main components.',
          'Explain one data flow from request to storage.',
          'State one trade-off and why you chose it.',
        ],
      },
    ],
    quiz: [
      {
        id: 'clarify-first',
        question: 'What should happen before proposing an architecture?',
        options: [
          'Clarify requirements and constraints',
          'Pick random technologies',
          'Ignore users',
          'Write production code immediately',
        ],
        correct_option_index: 0,
        explanation:
          'Requirements and constraints define what the architecture must optimize for.',
      },
      {
        id: 'tradeoff',
        question: 'Why mention trade-offs in system design?',
        options: [
          'To show the reasoning behind a choice',
          'To avoid answering',
          'To make the design impossible',
          'To hide requirements',
        ],
        correct_option_index: 0,
        explanation:
          'Trade-offs show that you understand the consequences of design choices.',
      },
    ],
    exercise: {
      id: 'design-job-board',
      title: 'Design a job board search flow',
      prompt:
        'Create a system design outline for searching job posts with filters, saved searches, and basic scaling concerns.',
      acceptance_criteria: [
        'Requirements and assumptions are listed first.',
        'The design includes API, database, and search components.',
        'At least one bottleneck and trade-off is explained.',
      ],
      proof_of_completion:
        'Save the diagram or outline and a 2-minute spoken walkthrough script.',
    },
  },
  llm_engineering: {
    title: 'LLM engineering basics for product features',
    summary:
      'Learn how to build safer LLM features by shaping inputs, controlling outputs, grounding responses, and evaluating failures instead of trusting model text blindly.',
    sections: [
      {
        id: 'prompt-contract',
        title: 'Prompt contract and output shape',
        body:
          'A production prompt should define the task, input boundaries, allowed behavior, and expected output shape. Structured output makes responses easier to validate.',
        checklist: [
          'Write a prompt with task, context, and constraints.',
          'Define a JSON or section-based output shape.',
          'Add a rule for insufficient evidence.',
        ],
      },
      {
        id: 'grounding-evaluation',
        title: 'Grounding and evaluation',
        body:
          'LLM features need evidence and tests. Ground answers in supplied data when possible, then evaluate common failure cases such as hallucination, missing fields, and unsafe advice.',
        checklist: [
          'Provide the model with explicit source context.',
          'Create two test cases for expected behavior.',
          'Create one test case where the model should refuse or ask for more data.',
        ],
      },
    ],
    quiz: [
      {
        id: 'structured-output',
        question: 'Why request structured output from an LLM?',
        options: [
          'It is easier to validate and render',
          'It guarantees the model is always correct',
          'It removes the need for tests',
          'It hides missing evidence',
        ],
        correct_option_index: 0,
        explanation:
          'Structured output helps the application parse, validate, and display responses consistently.',
      },
      {
        id: 'insufficient-evidence',
        question: 'What should an LLM feature do when evidence is insufficient?',
        options: [
          'Say what is missing or ask for more data',
          'Invent a confident answer',
          'Ignore the user',
          'Return unrelated content',
        ],
        correct_option_index: 0,
        explanation:
          'Honest insufficient-evidence behavior reduces hallucination risk.',
      },
    ],
    exercise: {
      id: 'cv-feedback-prompt',
      title: 'Design a grounded CV feedback prompt',
      prompt:
        'Write a prompt contract that reviews a CV section using only supplied evidence and returns structured feedback.',
      acceptance_criteria: [
        'The prompt separates task, evidence, rules, and output shape.',
        'The output includes at least one field for uncertainty or missing evidence.',
        'Two evaluation examples are written: one strong input and one insufficient input.',
      ],
      proof_of_completion:
        'Save the prompt, output schema, and two evaluation examples.',
    },
  },
} satisfies Record<SkillBridgeLessonSkill, LessonBlueprint>;

function buildLesson(
  skill: SkillBridgeLessonSkill,
  blueprint: LessonBlueprint,
): Omit<SkillBridgeLessonContent, 'source_resource_ids'> {
  return {
    skill_canonical: skill,
    title: blueprint.title,
    summary: blueprint.summary,
    license_type: 'skillbridge_original',
    reuse_policy: 'full_reuse_allowed',
    sections: blueprint.sections,
    quiz: blueprint.quiz,
    exercises: [blueprint.exercise],
  };
}

const LESSONS: Record<string, Omit<SkillBridgeLessonContent, 'source_resource_ids'>> = {};

for (const skill of SKILLBRIDGE_LESSON_SKILLS) {
  LESSONS[skill] = buildLesson(skill, LESSON_BLUEPRINTS[skill]);
}

export function getSkillBridgeLessonContent(
  skillCanonical: string,
  sourceResourceIds: string[] = [],
): SkillBridgeLessonContent | undefined {
  const lesson = LESSONS[skillCanonical];
  if (!lesson) return undefined;
  return {
    ...lesson,
    source_resource_ids: sourceResourceIds,
  };
}
