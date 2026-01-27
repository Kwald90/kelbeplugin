<?php
/**
 * Proposal Handler
 *
 * Manages proposal CRUD and sending
 *
 * @package Kelbe_Project_Tracker
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Proposal Handler class
 */
class KPT_Proposal_Handler {
    
    /**
     * Single instance of the class
     *
     * @var KPT_Proposal_Handler
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return KPT_Proposal_Handler
     */
    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }
    
    /**
     * Constructor
     */
    private function __construct() {
        add_action('wp_ajax_kpt_create_proposal', array($this, 'ajax_create_proposal'));
        add_action('wp_ajax_kpt_update_proposal', array($this, 'ajax_update_proposal'));
        add_action('wp_ajax_kpt_delete_proposal', array($this, 'ajax_delete_proposal'));
        add_action('wp_ajax_kpt_send_proposal', array($this, 'ajax_send_proposal'));
        add_action('wp_ajax_kpt_sign_proposal', array($this, 'ajax_sign_proposal'));
        add_action('wp_ajax_nopriv_kpt_view_proposal', array($this, 'ajax_view_proposal'));
        add_action('wp_ajax_nopriv_kpt_sign_proposal', array($this, 'ajax_sign_proposal'));
    }
    
    /**
     * Get proposals for a project
     *
     * @param int $project_id Project ID
     * @param string $status Optional status filter
     * @return array Proposals
     */
    public function get_proposals($project_id, $status = null) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_proposals';
        
        $where = $wpdb->prepare('project_id = %d', $project_id);
        
        if ($status !== null) {
            $where .= $wpdb->prepare(' AND status = %s', $status);
        }
        
        return $wpdb->get_results("SELECT * FROM $table WHERE $where ORDER BY version DESC, id DESC");
    }
    
    /**
     * Get a single proposal
     *
     * @param int $proposal_id Proposal ID
     * @return object|null Proposal object or null
     */
    public function get_proposal($proposal_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_proposals';
        
        return $wpdb->get_row($wpdb->prepare("SELECT * FROM $table WHERE id = %d", $proposal_id));
    }
    
    /**
     * Get proposal by access token
     *
     * @param string $token Access token
     * @return object|null Proposal object or null
     */
    public function get_proposal_by_token($token) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_proposals';
        
        return $wpdb->get_row($wpdb->prepare("SELECT * FROM $table WHERE access_token = %s", $token));
    }
    
    /**
     * Create a proposal
     *
     * @param array $data Proposal data
     * @return int|false Proposal ID on success, false on failure
     */
    public function create_proposal($data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_proposals';
        
        // Get next version number for this project
        $version = $this->get_next_version($data['project_id']);
        
        $defaults = array(
            'project_id' => 0,
            'proposal_number' => $this->generate_proposal_number(),
            'version' => $version,
            'line_items' => array(),
            'subtotal' => 0.00,
            'tax' => 0.00,
            'total' => 0.00,
            'deposit_amount' => 0.00,
            'deposit_percentage' => 0,
            'terms_text' => '',
            'status' => 'draft',
            'access_token' => $this->generate_access_token(),
        );
        
        $data = wp_parse_args($data, $defaults);
        
        // Sanitize data
        $insert_data = array(
            'project_id' => absint($data['project_id']),
            'proposal_number' => sanitize_text_field($data['proposal_number']),
            'version' => absint($data['version']),
            'line_items' => wp_json_encode($data['line_items']),
            'subtotal' => floatval($data['subtotal']),
            'tax' => floatval($data['tax']),
            'total' => floatval($data['total']),
            'deposit_amount' => floatval($data['deposit_amount']),
            'deposit_percentage' => absint($data['deposit_percentage']),
            'terms_text' => sanitize_textarea_field($data['terms_text']),
            'status' => sanitize_text_field($data['status']),
            'access_token' => sanitize_text_field($data['access_token']),
        );
        
        $result = $wpdb->insert($table, $insert_data);
        
        if ($result === false) {
            return false;
        }
        
        $proposal_id = $wpdb->insert_id;
        
        do_action('kpt_proposal_created', $proposal_id, $data);
        
        return $proposal_id;
    }
    
    /**
     * Update a proposal
     *
     * @param int $proposal_id Proposal ID
     * @param array $data Proposal data
     * @return bool True on success, false on failure
     */
    public function update_proposal($proposal_id, $data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_proposals';
        
        $proposal = $this->get_proposal($proposal_id);
        if (!$proposal) {
            return false;
        }
        
        $update_data = array();
        
        if (isset($data['line_items'])) {
            $update_data['line_items'] = wp_json_encode($data['line_items']);
        }
        
        if (isset($data['subtotal'])) {
            $update_data['subtotal'] = floatval($data['subtotal']);
        }
        
        if (isset($data['tax'])) {
            $update_data['tax'] = floatval($data['tax']);
        }
        
        if (isset($data['total'])) {
            $update_data['total'] = floatval($data['total']);
        }
        
        if (isset($data['deposit_amount'])) {
            $update_data['deposit_amount'] = floatval($data['deposit_amount']);
        }
        
        if (isset($data['deposit_percentage'])) {
            $update_data['deposit_percentage'] = absint($data['deposit_percentage']);
        }
        
        if (isset($data['terms_text'])) {
            $update_data['terms_text'] = sanitize_textarea_field($data['terms_text']);
        }
        
        if (isset($data['status'])) {
            $update_data['status'] = sanitize_text_field($data['status']);
        }
        
        $result = $wpdb->update($table, $update_data, array('id' => $proposal_id));
        
        if ($result !== false) {
            do_action('kpt_proposal_updated', $proposal_id, $data);
        }
        
        return $result !== false;
    }
    
    /**
     * Delete a proposal
     *
     * @param int $proposal_id Proposal ID
     * @return bool True on success, false on failure
     */
    public function delete_proposal($proposal_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_proposals';
        
        $proposal = $this->get_proposal($proposal_id);
        if (!$proposal) {
            return false;
        }
        
        $result = $wpdb->delete($table, array('id' => $proposal_id), array('%d'));
        
        if ($result !== false) {
            do_action('kpt_proposal_deleted', $proposal_id, $proposal);
        }
        
        return $result !== false;
    }
    
    /**
     * Send proposal to client
     *
     * @param int $proposal_id Proposal ID
     * @param string $recipient_email Recipient email
     * @return bool True on success, false on failure
     */
    public function send_proposal($proposal_id, $recipient_email) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_proposals';
        
        $proposal = $this->get_proposal($proposal_id);
        if (!$proposal) {
            return false;
        }
        
        $project = get_post($proposal->project_id);
        if (!$project) {
            return false;
        }
        
        // Generate proposal link
        $proposal_url = home_url('/proposal/' . $proposal->access_token);
        
        // Send email
        $notification_handler = KPT_Notification_Handler::get_instance();
        $sent = $notification_handler->send_notification(
            $recipient_email,
            sprintf(__('Proposal for %s', 'kelbe-project-tracker'), $project->post_title),
            'proposal_sent',
            array(
                'project_id' => $proposal->project_id,
                'project_title' => $project->post_title,
                'proposal_id' => $proposal_id,
                'proposal_number' => $proposal->proposal_number,
                'proposal_url' => $proposal_url,
                'total' => $proposal->total,
            )
        );
        
        if ($sent) {
            // Update proposal status
            $wpdb->update(
                $table,
                array(
                    'status' => 'sent',
                    'sent_at' => current_time('mysql'),
                ),
                array('id' => $proposal_id)
            );
            
            do_action('kpt_proposal_sent', $proposal_id, $recipient_email);
        }
        
        return $sent;
    }
    
    /**
     * Sign proposal
     *
     * @param int $proposal_id Proposal ID
     * @param string $signature_data Signature data (base64 image)
     * @return bool True on success, false on failure
     */
    public function sign_proposal($proposal_id, $signature_data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_proposals';
        
        $proposal = $this->get_proposal($proposal_id);
        if (!$proposal) {
            return false;
        }
        
        $update_data = array(
            'status' => 'signed',
            'signed_at' => current_time('mysql'),
            'client_signature' => $signature_data,
        );
        
        $result = $wpdb->update($table, $update_data, array('id' => $proposal_id));
        
        if ($result !== false) {
            do_action('kpt_proposal_signed', $proposal_id);
            
            // Send notification to project owner
            $this->send_signed_notification($proposal_id);
        }
        
        return $result !== false;
    }
    
    /**
     * Track proposal view
     *
     * @param int $proposal_id Proposal ID
     */
    public function track_view($proposal_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_proposals';
        
        $proposal = $this->get_proposal($proposal_id);
        if (!$proposal || $proposal->viewed_at) {
            return;
        }
        
        $wpdb->update(
            $table,
            array('viewed_at' => current_time('mysql')),
            array('id' => $proposal_id)
        );
        
        do_action('kpt_proposal_viewed', $proposal_id);
    }
    
    /**
     * Generate proposal number
     *
     * @return string Proposal number
     */
    private function generate_proposal_number() {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_proposals';
        
        $count = $wpdb->get_var("SELECT COUNT(*) FROM $table");
        $number = str_pad($count + 1, 6, '0', STR_PAD_LEFT);
        
        return 'PROP-' . date('Y') . '-' . $number;
    }
    
    /**
     * Generate access token
     *
     * @return string Access token
     */
    private function generate_access_token() {
        // Generate a cryptographically secure token
        // Note: Token expiration should be implemented based on business requirements
        // Consider adding expiration timestamp in the token or separate expiration field
        return bin2hex(random_bytes(32));
    }
    
    /**
     * Get next version number for project
     *
     * @param int $project_id Project ID
     * @return int Version number
     */
    private function get_next_version($project_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_proposals';
        
        $max_version = $wpdb->get_var($wpdb->prepare(
            "SELECT MAX(version) FROM $table WHERE project_id = %d",
            $project_id
        ));
        
        return $max_version ? ($max_version + 1) : 1;
    }
    
    /**
     * Send signed notification
     *
     * @param int $proposal_id Proposal ID
     */
    private function send_signed_notification($proposal_id) {
        $proposal = $this->get_proposal($proposal_id);
        if (!$proposal) {
            return;
        }
        
        $project = get_post($proposal->project_id);
        if (!$project) {
            return;
        }
        
        $owner = get_userdata($project->post_author);
        if (!$owner) {
            return;
        }
        
        $notification_handler = KPT_Notification_Handler::get_instance();
        $notification_handler->send_notification(
            $owner->user_email,
            sprintf(__('Proposal Signed: %s', 'kelbe-project-tracker'), $proposal->proposal_number),
            'proposal_signed',
            array(
                'project_id' => $proposal->project_id,
                'project_title' => $project->post_title,
                'proposal_id' => $proposal_id,
                'proposal_number' => $proposal->proposal_number,
                'total' => $proposal->total,
            )
        );
    }
    
    /**
     * AJAX: Create proposal
     */
    public function ajax_create_proposal() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $project_id = isset($_POST['project_id']) ? absint($_POST['project_id']) : 0;
        
        if (!$project_id || !$this->user_can_manage_proposals($project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $data = array(
            'project_id' => $project_id,
            'line_items' => isset($_POST['line_items']) ? $_POST['line_items'] : array(),
            'subtotal' => isset($_POST['subtotal']) ? floatval($_POST['subtotal']) : 0.00,
            'tax' => isset($_POST['tax']) ? floatval($_POST['tax']) : 0.00,
            'total' => isset($_POST['total']) ? floatval($_POST['total']) : 0.00,
            'deposit_amount' => isset($_POST['deposit_amount']) ? floatval($_POST['deposit_amount']) : 0.00,
            'deposit_percentage' => isset($_POST['deposit_percentage']) ? absint($_POST['deposit_percentage']) : 0,
            'terms_text' => isset($_POST['terms_text']) ? sanitize_textarea_field($_POST['terms_text']) : '',
        );
        
        $proposal_id = $this->create_proposal($data);
        
        if ($proposal_id) {
            wp_send_json_success(array(
                'message' => __('Proposal created.', 'kelbe-project-tracker'),
                'proposal_id' => $proposal_id,
                'proposal' => $this->get_proposal($proposal_id),
            ));
        } else {
            wp_send_json_error(__('Failed to create proposal.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Update proposal
     */
    public function ajax_update_proposal() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $proposal_id = isset($_POST['proposal_id']) ? absint($_POST['proposal_id']) : 0;
        $proposal = $this->get_proposal($proposal_id);
        
        if (!$proposal || !$this->user_can_manage_proposals($proposal->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $data = array();
        
        if (isset($_POST['line_items'])) {
            $data['line_items'] = $_POST['line_items'];
        }
        
        if (isset($_POST['terms_text'])) {
            $data['terms_text'] = sanitize_textarea_field($_POST['terms_text']);
        }
        
        if (isset($_POST['subtotal'])) {
            $data['subtotal'] = floatval($_POST['subtotal']);
        }
        
        if (isset($_POST['tax'])) {
            $data['tax'] = floatval($_POST['tax']);
        }
        
        if (isset($_POST['total'])) {
            $data['total'] = floatval($_POST['total']);
        }
        
        if ($this->update_proposal($proposal_id, $data)) {
            wp_send_json_success(array(
                'message' => __('Proposal updated.', 'kelbe-project-tracker'),
                'proposal' => $this->get_proposal($proposal_id),
            ));
        } else {
            wp_send_json_error(__('Failed to update proposal.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Delete proposal
     */
    public function ajax_delete_proposal() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $proposal_id = isset($_POST['proposal_id']) ? absint($_POST['proposal_id']) : 0;
        $proposal = $this->get_proposal($proposal_id);
        
        if (!$proposal || !$this->user_can_manage_proposals($proposal->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        if ($this->delete_proposal($proposal_id)) {
            wp_send_json_success(__('Proposal deleted.', 'kelbe-project-tracker'));
        } else {
            wp_send_json_error(__('Failed to delete proposal.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Send proposal
     */
    public function ajax_send_proposal() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $proposal_id = isset($_POST['proposal_id']) ? absint($_POST['proposal_id']) : 0;
        $proposal = $this->get_proposal($proposal_id);
        
        if (!$proposal || !$this->user_can_manage_proposals($proposal->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $recipient_email = isset($_POST['recipient_email']) ? sanitize_email($_POST['recipient_email']) : '';
        
        if (!is_email($recipient_email)) {
            wp_send_json_error(__('Invalid email address.', 'kelbe-project-tracker'));
        }
        
        if ($this->send_proposal($proposal_id, $recipient_email)) {
            wp_send_json_success(__('Proposal sent successfully.', 'kelbe-project-tracker'));
        } else {
            wp_send_json_error(__('Failed to send proposal.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Sign proposal
     */
    public function ajax_sign_proposal() {
        $token = isset($_POST['token']) ? sanitize_text_field($_POST['token']) : '';
        
        if (!$token) {
            wp_send_json_error(__('Invalid token.', 'kelbe-project-tracker'));
        }
        
        $proposal = $this->get_proposal_by_token($token);
        
        if (!$proposal) {
            wp_send_json_error(__('Proposal not found.', 'kelbe-project-tracker'));
        }
        
        $signature_data = isset($_POST['signature']) ? $_POST['signature'] : '';
        
        if (!$signature_data) {
            wp_send_json_error(__('Signature is required.', 'kelbe-project-tracker'));
        }
        
        if ($this->sign_proposal($proposal->id, $signature_data)) {
            wp_send_json_success(__('Proposal signed successfully.', 'kelbe-project-tracker'));
        } else {
            wp_send_json_error(__('Failed to sign proposal.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: View proposal (track view)
     */
    public function ajax_view_proposal() {
        $token = isset($_POST['token']) ? sanitize_text_field($_POST['token']) : '';
        
        if (!$token) {
            wp_send_json_error(__('Invalid token.', 'kelbe-project-tracker'));
        }
        
        $proposal = $this->get_proposal_by_token($token);
        
        if (!$proposal) {
            wp_send_json_error(__('Proposal not found.', 'kelbe-project-tracker'));
        }
        
        $this->track_view($proposal->id);
        
        wp_send_json_success(array(
            'proposal' => $proposal,
        ));
    }
    
    /**
     * Check if user can manage proposals for a project
     *
     * @param int $project_id Project ID
     * @return bool True if user can manage, false otherwise
     */
    private function user_can_manage_proposals($project_id) {
        $user_id = get_current_user_id();
        
        // Admins can always manage
        if (current_user_can('manage_options')) {
            return true;
        }
        
        // Project author can manage
        $project = get_post($project_id);
        if ($project && $project->post_author == $user_id) {
            return true;
        }
        
        return false;
    }
}
