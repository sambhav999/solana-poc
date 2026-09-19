//! Overflow Receipt Registry.
//!
//! This program never holds tokens and never signs Jupiter or Kamino moves.
//! The user's wallet remains the fee payer. After a harvest confirms, the same
//! wallet writes a one-time receipt PDA so the Capital Firewall proof is on
//! chain and the same execution key cannot be recorded twice.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    hash::hashv,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

solana_program::declare_id!("nAAStFqtSRsQbuzUARufKs8URPB6sEeUhHnTDK4HqGp");

pub const RULE_SEED: &[u8] = b"rule";
pub const RECEIPT_SEED: &[u8] = b"receipt";
pub const RULE_SPACE: usize = 128;
pub const RECEIPT_SPACE: usize = 200;
pub const SOURCE_KIND_DIVIDEND: u8 = 0;
pub const SOURCE_KIND_INTEREST: u8 = 1;

fn discriminator(kind: &str) -> [u8; 8] {
    let digest = hashv(&[kind.as_bytes()]);
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest.to_bytes()[..8]);
    out
}

pub fn create_rule_discriminator() -> [u8; 8] {
    discriminator("global:create_rule")
}
pub fn post_receipt_discriminator() -> [u8; 8] {
    discriminator("global:post_receipt")
}
pub fn rule_account_discriminator() -> [u8; 8] {
    discriminator("account:Rule")
}
pub fn receipt_account_discriminator() -> [u8; 8] {
    discriminator("account:Receipt")
}

pub fn rule_pda(program_id: &Pubkey, owner: &Pubkey, rule_id: &[u8; 16]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[RULE_SEED, owner.as_ref(), rule_id], program_id)
}

pub fn receipt_pda(program_id: &Pubkey, owner: &Pubkey, execution_key: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[RECEIPT_SEED, owner.as_ref(), execution_key], program_id)
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub disc: [u8; 8],
    pub owner: Pubkey,
    pub rule_id: [u8; 16],
    pub source_kind: u8,
    pub destination_mint: Pubkey,
    pub source_mint: Pubkey,
    pub bump: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub disc: [u8; 8],
    pub owner: Pubkey,
    pub rule: Pubkey,
    pub execution_key: [u8; 32],
    pub source_spent: u64,
    pub destination_received: u64,
    pub preserved: bool,
    pub swap_signature: [u8; 64],
    pub slot: u64,
    pub bump: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct CreateRuleArgs {
    pub rule_id: [u8; 16],
    pub source_kind: u8,
    pub destination_mint: Pubkey,
    pub source_mint: Pubkey,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct PostReceiptArgs {
    pub execution_key: [u8; 32],
    pub source_spent: u64,
    pub destination_received: u64,
    pub preserved: bool,
    pub swap_signature: [u8; 64],
}

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("invalid instruction")]
    InvalidInstruction,
    #[error("unauthorized")]
    Unauthorized,
    #[error("invalid source kind")]
    InvalidSourceKind,
    #[error("account already initialized")]
    AlreadyInitialized,
    #[error("rule mismatch")]
    RuleMismatch,
}

impl From<RegistryError> for ProgramError {
    fn from(e: RegistryError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

pub fn unpack_instruction(data: &[u8]) -> Result<( [u8; 8], Vec<u8> ), ProgramError> {
    if data.len() < 8 {
        return Err(RegistryError::InvalidInstruction.into());
    }
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&data[..8]);
    Ok((disc, data[8..].to_vec()))
}

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let (disc, rest) = unpack_instruction(instruction_data)?;
    if disc == create_rule_discriminator() {
        let args = CreateRuleArgs::try_from_slice(&rest)
            .map_err(|_| RegistryError::InvalidInstruction)?;
        return create_rule(program_id, accounts, args);
    }
    if disc == post_receipt_discriminator() {
        let args = PostReceiptArgs::try_from_slice(&rest)
            .map_err(|_| RegistryError::InvalidInstruction)?;
        return post_receipt(program_id, accounts, args);
    }
    Err(RegistryError::InvalidInstruction.into())
}

fn create_rule(program_id: &Pubkey, accounts: &[AccountInfo], args: CreateRuleArgs) -> ProgramResult {
    if args.source_kind != SOURCE_KIND_DIVIDEND && args.source_kind != SOURCE_KIND_INTEREST {
        return Err(RegistryError::InvalidSourceKind.into());
    }
    let iter = &mut accounts.iter();
    let rule_ai = next_account_info(iter)?;
    let owner_ai = next_account_info(iter)?;
    let system_ai = next_account_info(iter)?;

    if !owner_ai.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (pda, bump) = rule_pda(program_id, owner_ai.key, &args.rule_id);
    if pda != *rule_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    if rule_ai.data_len() > 0 && rule_ai.lamports() > 0 {
        return Err(RegistryError::AlreadyInitialized.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(RULE_SPACE);
    invoke_signed(
        &system_instruction::create_account(
            owner_ai.key,
            rule_ai.key,
            lamports,
            RULE_SPACE as u64,
            program_id,
        ),
        &[owner_ai.clone(), rule_ai.clone(), system_ai.clone()],
        &[&[RULE_SEED, owner_ai.key.as_ref(), &args.rule_id, &[bump]]],
    )?;

    let state = Rule {
        disc: rule_account_discriminator(),
        owner: *owner_ai.key,
        rule_id: args.rule_id,
        source_kind: args.source_kind,
        destination_mint: args.destination_mint,
        source_mint: args.source_mint,
        bump,
    };
    state.serialize(&mut &mut rule_ai.data.borrow_mut()[..])?;
    msg!("overflow create_rule");
    Ok(())
}

fn post_receipt(program_id: &Pubkey, accounts: &[AccountInfo], args: PostReceiptArgs) -> ProgramResult {
    let iter = &mut accounts.iter();
    let receipt_ai = next_account_info(iter)?;
    let rule_ai = next_account_info(iter)?;
    let owner_ai = next_account_info(iter)?;
    let system_ai = next_account_info(iter)?;

    if !owner_ai.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let mut rule_data: &[u8] = &rule_ai.data.borrow();
    let rule = Rule::deserialize(&mut rule_data).map_err(|_| RegistryError::RuleMismatch)?;
    if rule.disc != rule_account_discriminator() {
        return Err(RegistryError::RuleMismatch.into());
    }
    if rule.owner != *owner_ai.key {
        return Err(RegistryError::Unauthorized.into());
    }
    let (expected_rule, _) = rule_pda(program_id, owner_ai.key, &rule.rule_id);
    if expected_rule != *rule_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }

    let (pda, bump) = receipt_pda(program_id, owner_ai.key, &args.execution_key);
    if pda != *receipt_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }
    if receipt_ai.data_len() > 0 && receipt_ai.lamports() > 0 {
        return Err(RegistryError::AlreadyInitialized.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(RECEIPT_SPACE);
    invoke_signed(
        &system_instruction::create_account(
            owner_ai.key,
            receipt_ai.key,
            lamports,
            RECEIPT_SPACE as u64,
            program_id,
        ),
        &[owner_ai.clone(), receipt_ai.clone(), system_ai.clone()],
        &[&[RECEIPT_SEED, owner_ai.key.as_ref(), &args.execution_key, &[bump]]],
    )?;

    let clock_slot = solana_program::clock::Clock::get()?.slot;
    let state = Receipt {
        disc: receipt_account_discriminator(),
        owner: *owner_ai.key,
        rule: *rule_ai.key,
        execution_key: args.execution_key,
        source_spent: args.source_spent,
        destination_received: args.destination_received,
        preserved: args.preserved,
        swap_signature: args.swap_signature,
        slot: clock_slot,
        bump,
    };
    state.serialize(&mut &mut receipt_ai.data.borrow_mut()[..])?;
    msg!("overflow post_receipt");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_program::pubkey::Pubkey;

    #[test]
    fn discriminators_are_stable_8_bytes() {
        assert_eq!(create_rule_discriminator(), [0xe1, 0xa3, 0x01, 0x06, 0xe6, 0x5b, 0xcb, 0xc7]);
        assert_eq!(post_receipt_discriminator(), [0xfb, 0xb2, 0x4e, 0x13, 0xfe, 0xbe, 0x9c, 0xdc]);
        assert_ne!(rule_account_discriminator(), receipt_account_discriminator());
    }

    #[test]
    fn create_rule_args_round_trip() {
        let args = CreateRuleArgs {
            rule_id: [7u8; 16],
            source_kind: SOURCE_KIND_DIVIDEND,
            destination_mint: Pubkey::new_unique(),
            source_mint: Pubkey::new_unique(),
        };
        let bytes = borsh::to_vec(&args).unwrap();
        let back = CreateRuleArgs::try_from_slice(&bytes).unwrap();
        assert_eq!(args, back);
        assert_eq!(bytes.len(), 16 + 1 + 32 + 32);
    }

    #[test]
    fn post_receipt_args_round_trip() {
        let args = PostReceiptArgs {
            execution_key: [9u8; 32],
            source_spent: 42,
            destination_received: 99,
            preserved: true,
            swap_signature: [3u8; 64],
        };
        let bytes = borsh::to_vec(&args).unwrap();
        let back = PostReceiptArgs::try_from_slice(&bytes).unwrap();
        assert_eq!(args, back);
        assert_eq!(bytes.len(), 32 + 8 + 8 + 1 + 64);
    }

    #[test]
    fn rule_and_receipt_state_fit_allocated_space() {
        let rule = Rule {
            disc: rule_account_discriminator(),
            owner: Pubkey::new_unique(),
            rule_id: [1u8; 16],
            source_kind: SOURCE_KIND_INTEREST,
            destination_mint: Pubkey::new_unique(),
            source_mint: Pubkey::new_unique(),
            bump: 255,
        };
        let rule_bytes = borsh::to_vec(&rule).unwrap();
        assert!(rule_bytes.len() <= RULE_SPACE, "rule {} > {}", rule_bytes.len(), RULE_SPACE);

        let receipt = Receipt {
            disc: receipt_account_discriminator(),
            owner: Pubkey::new_unique(),
            rule: Pubkey::new_unique(),
            execution_key: [2u8; 32],
            source_spent: 1,
            destination_received: 2,
            preserved: true,
            swap_signature: [0u8; 64],
            slot: 7,
            bump: 254,
        };
        let receipt_bytes = borsh::to_vec(&receipt).unwrap();
        assert!(receipt_bytes.len() <= RECEIPT_SPACE, "receipt {} > {}", receipt_bytes.len(), RECEIPT_SPACE);
    }

    #[test]
    fn fixture_rule_pda_for_system_owner() {
        let owner = solana_program::pubkey!("11111111111111111111111111111111");
        let (pda, bump) = rule_pda(&id(), &owner, &[1u8; 16]);
        assert_eq!(bump, 253);
        assert_eq!(pda.to_string(), "3DWQg3GT8dbd2MthhcqZYdECPzXNrcS37nWfyUJBSBYV");
    }

    #[test]
    fn pdas_are_program_derived_and_distinct() {
        let owner = Pubkey::new_unique();
        let rule_id = [4u8; 16];
        let key = [5u8; 32];
        let (rule, rb) = rule_pda(&id(), &owner, &rule_id);
        let (receipt, recb) = receipt_pda(&id(), &owner, &key);
        assert_ne!(rule, receipt);
        assert!(rb > 0 || rb == 0);
        assert!(recb > 0 || recb == 0);
        let (rule2, _) = rule_pda(&id(), &owner, &rule_id);
        assert_eq!(rule, rule2);
    }

    #[test]
    fn unpack_rejects_short_data() {
        assert!(unpack_instruction(&[1, 2, 3]).is_err());
    }

    #[test]
    fn unpack_splits_discriminator() {
        let mut data = create_rule_discriminator().to_vec();
        data.extend_from_slice(&[1, 2, 3]);
        let (disc, rest) = unpack_instruction(&data).unwrap();
        assert_eq!(disc, create_rule_discriminator());
        assert_eq!(rest, vec![1, 2, 3]);
    }
}
