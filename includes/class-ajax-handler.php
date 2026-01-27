<?php
/**
 * AJAX Handler
 *
 * Handles all AJAX requests for the Kelbe Project Tracker plugin.
 *
 * @package    Kelbe_Project_Tracker
 * @subpackage Kelbe_Project_Tracker/includes
 * @since      1.0.0
 */

// If this file is called directly, abort.
if ( ! defined( 'WPINC' ) ) {
	die;
}

/**
 * AJAX Handler Class
 *
 * @since 1.0.0
 */
class KPT_Ajax_Handler {

	/**
	 * The single instance of the class.
	 *
	 * @since  1.0.0
	 * @access protected
	 * @var    KPT_Ajax_Handler
	 */
	protected static $instance = null;

	/**
	 * Main Instance
	 *
	 * Ensures only one instance of the class is loaded or can be loaded.
	 *
	 * @since  1.0.0
	 * @return KPT_Ajax_Handler - Main instance.
	 */
	public static function instance() {
		if ( is_null( self::$instance ) ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Constructor
	 *
	 * @since 1.0.0
	 */
	private function __construct() {
		$this->register_ajax_actions();
	}

	/**
	 * Register all AJAX actions
	 *
	 * @since 1.0.0
	 */
	private function register_ajax_actions() {
		// Checklist actions.
		add_action( 'wp_ajax_kpt_toggle_checklist_item', array( $this, 'toggle_checklist_item' ) );
		add_action( 'wp_ajax_kpt_add_checklist_item', array( $this, 'add_checklist_item' ) );
		add_action( 'wp_ajax_kpt_delete_checklist_item', array( $this, 'delete_checklist_item' ) );
		add_action( 'wp_ajax_kpt_reorder_checklist_items', array( $this, 'reorder_checklist_items' ) );

		// Team actions.
		add_action( 'wp_ajax_kpt_add_team_member', array( $this, 'add_team_member' ) );
		add_action( 'wp_ajax_kpt_remove_team_member', array( $this, 'remove_team_member' ) );
		add_action( 'wp_ajax_kpt_get_team_members', array( $this, 'get_team_members' ) );
		add_action( 'wp_ajax_kpt_update_member_permissions', array( $this, 'update_member_permissions' ) );

		// Bid actions.
		add_action( 'wp_ajax_kpt_save_bid', array( $this, 'save_bid' ) );
		add_action( 'wp_ajax_kpt_submit_bid', array( $this, 'submit_bid' ) );
		add_action( 'wp_ajax_kpt_review_bid', array( $this, 'review_bid' ) );
		add_action( 'wp_ajax_kpt_get_bid_details', array( $this, 'get_bid_details' ) );

		// Proposal actions.
		add_action( 'wp_ajax_kpt_generate_proposal', array( $this, 'generate_proposal' ) );
		add_action( 'wp_ajax_kpt_send_proposal', array( $this, 'send_proposal' ) );
		add_action( 'wp_ajax_kpt_sign_proposal', array( $this, 'sign_proposal' ) );

		// Lead actions.
		add_action( 'wp_ajax_kpt_create_lead', array( $this, 'create_lead' ) );
		add_action( 'wp_ajax_kpt_update_lead', array( $this, 'update_lead' ) );
		add_action( 'wp_ajax_kpt_convert_lead', array( $this, 'convert_lead' ) );
		add_action( 'wp_ajax_kpt_delete_lead', array( $this, 'delete_lead' ) );

		// File actions.
		add_action( 'wp_ajax_kpt_upload_file', array( $this, 'upload_file' ) );
		add_action( 'wp_ajax_kpt_delete_file', array( $this, 'delete_file' ) );

		// Change order actions.
		add_action( 'wp_ajax_kpt_create_change_order', array( $this, 'create_change_order' ) );
		add_action( 'wp_ajax_kpt_approve_change_order', array( $this, 'approve_change_order' ) );

		// Project actions.
		add_action( 'wp_ajax_kpt_create_project', array( $this, 'create_project' ) );
		add_action( 'wp_ajax_kpt_update_project', array( $this, 'update_project' ) );
		add_action( 'wp_ajax_kpt_update_project_stage', array( $this, 'update_project_stage' ) );

		// Settings actions.
		add_action( 'wp_ajax_kpt_save_settings', array( $this, 'save_settings' ) );
	}

	/**
	 * Verify nonce for AJAX requests
	 *
	 * @since  1.0.0
	 * @param  string $action Nonce action name.
	 * @return bool True if nonce is valid, false otherwise.
	 */
	protected function verify_nonce( $action = 'kpt_ajax_nonce' ) {
		$nonce = isset( $_POST['nonce'] ) ? sanitize_text_field( wp_unslash( $_POST['nonce'] ) ) : '';
		return wp_verify_nonce( $nonce, $action );
	}

	/**
	 * Check if user has capability
	 *
	 * @since  1.0.0
	 * @param  string $capability Capability to check.
	 * @return bool True if user has capability, false otherwise.
	 */
	protected function check_capability( $capability = 'read' ) {
		return current_user_can( $capability );
	}

	/**
	 * Send JSON success response
	 *
	 * @since 1.0.0
	 * @param mixed $data Data to send in response.
	 */
	protected function send_success( $data = null ) {
		wp_send_json_success( $data );
	}

	/**
	 * Send JSON error response
	 *
	 * @since 1.0.0
	 * @param string $message Error message.
	 * @param mixed  $data    Additional data.
	 */
	protected function send_error( $message, $data = null ) {
		wp_send_json_error(
			array(
				'message' => $message,
				'data'    => $data,
			)
		);
	}

	/**
	 * Toggle checklist item
	 *
	 * @since 1.0.0
	 */
	public function toggle_checklist_item() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement checklist toggle logic.
		$this->send_success( array( 'message' => __( 'Item toggled.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Add checklist item
	 *
	 * @since 1.0.0
	 */
	public function add_checklist_item() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement add checklist item logic.
		$this->send_success( array( 'message' => __( 'Item added.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Delete checklist item
	 *
	 * @since 1.0.0
	 */
	public function delete_checklist_item() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement delete checklist item logic.
		$this->send_success( array( 'message' => __( 'Item deleted.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Reorder checklist items
	 *
	 * @since 1.0.0
	 */
	public function reorder_checklist_items() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement reorder checklist items logic.
		$this->send_success( array( 'message' => __( 'Items reordered.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Add team member
	 *
	 * @since 1.0.0
	 */
	public function add_team_member() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'manage_options' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement add team member logic.
		$this->send_success( array( 'message' => __( 'Team member added.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Remove team member
	 *
	 * @since 1.0.0
	 */
	public function remove_team_member() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'manage_options' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement remove team member logic.
		$this->send_success( array( 'message' => __( 'Team member removed.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Get team members
	 *
	 * @since 1.0.0
	 */
	public function get_team_members() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'read' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement get team members logic.
		$this->send_success( array( 'members' => array() ) );
	}

	/**
	 * Update member permissions
	 *
	 * @since 1.0.0
	 */
	public function update_member_permissions() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'manage_options' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement update member permissions logic.
		$this->send_success( array( 'message' => __( 'Permissions updated.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Save bid
	 *
	 * @since 1.0.0
	 */
	public function save_bid() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement save bid logic.
		$this->send_success( array( 'message' => __( 'Bid saved.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Submit bid
	 *
	 * @since 1.0.0
	 */
	public function submit_bid() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement submit bid logic.
		$this->send_success( array( 'message' => __( 'Bid submitted.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Review bid
	 *
	 * @since 1.0.0
	 */
	public function review_bid() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement review bid logic.
		$this->send_success( array( 'message' => __( 'Bid reviewed.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Get bid details
	 *
	 * @since 1.0.0
	 */
	public function get_bid_details() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'read' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement get bid details logic.
		$this->send_success( array( 'bid' => array() ) );
	}

	/**
	 * Generate proposal
	 *
	 * @since 1.0.0
	 */
	public function generate_proposal() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement generate proposal logic.
		$this->send_success( array( 'message' => __( 'Proposal generated.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Send proposal
	 *
	 * @since 1.0.0
	 */
	public function send_proposal() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement send proposal logic.
		$this->send_success( array( 'message' => __( 'Proposal sent.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Sign proposal
	 *
	 * @since 1.0.0
	 */
	public function sign_proposal() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'read' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement sign proposal logic.
		$this->send_success( array( 'message' => __( 'Proposal signed.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Create lead
	 *
	 * @since 1.0.0
	 */
	public function create_lead() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement create lead logic.
		$this->send_success( array( 'message' => __( 'Lead created.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Update lead
	 *
	 * @since 1.0.0
	 */
	public function update_lead() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement update lead logic.
		$this->send_success( array( 'message' => __( 'Lead updated.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Convert lead
	 *
	 * @since 1.0.0
	 */
	public function convert_lead() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement convert lead logic.
		$this->send_success( array( 'message' => __( 'Lead converted.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Delete lead
	 *
	 * @since 1.0.0
	 */
	public function delete_lead() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'delete_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement delete lead logic.
		$this->send_success( array( 'message' => __( 'Lead deleted.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Upload file
	 *
	 * @since 1.0.0
	 */
	public function upload_file() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'upload_files' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement upload file logic.
		$this->send_success( array( 'message' => __( 'File uploaded.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Delete file
	 *
	 * @since 1.0.0
	 */
	public function delete_file() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'delete_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement delete file logic.
		$this->send_success( array( 'message' => __( 'File deleted.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Create change order
	 *
	 * @since 1.0.0
	 */
	public function create_change_order() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement create change order logic.
		$this->send_success( array( 'message' => __( 'Change order created.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Approve change order
	 *
	 * @since 1.0.0
	 */
	public function approve_change_order() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement approve change order logic.
		$this->send_success( array( 'message' => __( 'Change order approved.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Create project
	 *
	 * @since 1.0.0
	 */
	public function create_project() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement create project logic.
		$this->send_success( array( 'message' => __( 'Project created.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Update project
	 *
	 * @since 1.0.0
	 */
	public function update_project() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement update project logic.
		$this->send_success( array( 'message' => __( 'Project updated.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Update project stage
	 *
	 * @since 1.0.0
	 */
	public function update_project_stage() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'edit_posts' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement update project stage logic.
		$this->send_success( array( 'message' => __( 'Project stage updated.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Save settings
	 *
	 * @since 1.0.0
	 */
	public function save_settings() {
		if ( ! $this->verify_nonce() ) {
			$this->send_error( __( 'Security check failed.', 'kelbe-project-tracker' ) );
		}

		if ( ! $this->check_capability( 'manage_options' ) ) {
			$this->send_error( __( 'Permission denied.', 'kelbe-project-tracker' ) );
		}

		// TODO: Implement save settings logic.
		$this->send_success( array( 'message' => __( 'Settings saved.', 'kelbe-project-tracker' ) ) );
	}

	/**
	 * Prevent cloning of the instance
	 *
	 * @since 1.0.0
	 */
	private function __clone() {}

	/**
	 * Prevent unserializing of the instance
	 *
	 * @since 1.0.0
	 */
	private function __wakeup() {}
}

// Initialize the class.
KPT_Ajax_Handler::instance();
