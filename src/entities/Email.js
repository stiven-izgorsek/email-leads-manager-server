import { EntitySchema } from 'typeorm';

export class Email {
  constructor(id, address, firstName, lastName, marketingDailyLimit, marketingAssignDefault, marketingEnabled, followupEnabled, accountId, status, password, appPassword, twoFa, recoveryEmail, grantId, nylasKey, chromePath, chromeUserDataDir, chromeProfileDirectory, gmailUIndex, createdAt, updatedAt, deletedAt) {
    this.id = id;
    this.address = address;
    this.firstName = firstName;
    this.lastName = lastName;
    this.marketingDailyLimit = marketingDailyLimit;
    this.marketingAssignDefault = marketingAssignDefault;
    this.marketingEnabled = marketingEnabled;
    this.followupEnabled = followupEnabled;
    this.accountId = accountId;
    this.status = status;
    this.password = password;
    this.appPassword = appPassword;
    this.twoFa = twoFa;
    this.recoveryEmail = recoveryEmail;
    this.grantId = grantId;
    this.nylasKey = nylasKey;
    this.chromePath = chromePath;
    this.chromeUserDataDir = chromeUserDataDir;
    this.chromeProfileDirectory = chromeProfileDirectory;
    this.gmailUIndex = gmailUIndex;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.deletedAt = deletedAt;
  }
}

export const EmailSchema = new EntitySchema({
  name: 'Email',
  target: Email,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    address: {
      type: 'varchar',
      length: 255,
      nullable: false,
    },
    firstName: {
      name: 'first_name',
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    lastName: {
      name: 'last_name',
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    marketingDailyLimit: {
      name: 'marketing_daily_limit',
      type: 'int',
      nullable: true,
    },
    marketingAssignDefault: {
      name: 'marketing_assign_default',
      type: 'int',
      nullable: true,
    },
    marketingEnabled: {
      name: 'marketing_enabled',
      type: 'boolean',
      nullable: false,
      default: true,
    },
    followupEnabled: {
      name: 'followup_enabled',
      type: 'boolean',
      nullable: false,
      default: true,
    },
    accountId: {
      type: 'uuid',
      nullable: true,
    },
    status: {
      type: 'varchar',
      length: 50,
      nullable: false,
      default: 'new',
    },
    password: {
      type: 'varchar',
      nullable: true,
    },
    appPassword: {
      name: 'app_password',
      type: 'varchar',
      nullable: true,
    },
    twoFa: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    recoveryEmail: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    grantId: {
      name: 'grant_id',
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    nylasKey: {
      name: 'nylas_key',
      type: 'varchar',
      length: 1000,
      nullable: true,
    },
    chromePath: {
      name: 'chrome_path',
      type: 'varchar',
      length: 1000,
      nullable: true,
    },
    chromeUserDataDir: {
      name: 'chrome_user_data_dir',
      type: 'varchar',
      length: 1000,
      nullable: true,
    },
    chromeProfileDirectory: {
      name: 'chrome_profile_directory',
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    gmailUIndex: {
      name: 'gmail_u_index',
      type: 'int',
      nullable: true,
    },
    createdAt: {
      type: 'timestamp',
      createDate: true,
    },
    updatedAt: {
      type: 'timestamp',
      updateDate: true,
    },
    deletedAt: {
      type: 'timestamp',
      nullable: true,
    },
  },
  relations: {
    account: {
      type: 'many-to-one',
      target: 'Account',
      joinColumn: { name: 'accountId', referencedColumnName: 'id' },
    },
  },
});
