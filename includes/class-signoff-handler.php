<?php
/**
 * Signoff Handler
 *
 * Sign-off system
 *
 * @package Kelbe_Project_Tracker
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Signoff Handler class
 */
class KPT_Signoff_Handler {
    
    /**
     * Single instance of the class
     *
     * @var KPT_Signoff_Handler
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return KPT_Signoff_Handler
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
        add_action('wp_ajax_kpt_create_signoff', array($this, 'ajax_create_signoff'));
        add_action('wp_ajax_kpt_sign_signoff', array($this, 'ajax_sign_signoff'));
        add_action('wp_ajax_kpt_get_signoffs', array($this, 'ajax_get_signoffs'));
        add_action('wp_ajax_kpt_delete_signoff', array($this, 'ajax_delete_signoff'));
        
        // Allow clients to sign (no auth required for specific token)
        add_action('wp_ajax_nopriv_kpt_sign_signoff_token', array($this, 'ajax_sign_signoff_token'));
    }
    
    /**
     * Get signoffs for a project
     *
     * @param int $project_id Project ID
     * @param int $stage Optional stage filter
     * @param string $status Optional status filter
     * @return array Signoffs
     */
    public function get_signoffs($project_id, $stage = null, $status = null) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_signoffs';
        
        $where = array($wpdb->prepare('project_id = %d', $project_id));
        
        if ($stage !== null) {
            $where[] = $wpdb->prepare('stage = %d', $stage);
        }
        
        if ($status !== null) {
            $where[] = $wpdb->prepare('status = %s', $status);
        }
        
        $sql = "SELECT * FROM $table WHERE " . implode(' AND ', $where) . " ORDER BY signed_at DESC, id DESC";
        
        $signoffs = $wpdb->get_results($sql);
        
        // Enrich with user data
        foreach ($signoffs as &$signoff) {
            if ($signoff->signed_by) {
                $user = get_userdata($signoff->signed_by);
                if ($user) {
                    $signoff->signed_by_name = $user->display_name;
                    $signoff->signed_by_email = $user->user_email;
                }
            }
        }
        
        return $signoffs;
    }
    
    /**
     * Get a single signoff
     *
     * @param int $signoff_id Signoff ID
     * @return object|null Signoff object or null
     */
    public function get_signoff($signoff_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_signoffs';
        
        return $wpdb->get_row($wpdb->prepare("SELECT * FROM $table WHERE id = %d", $signoff_id));
    }
    
    /**
     * Create a signoff
     *
     * @param array $data Signoff data
     * @return int|false Signoff ID on success, false on failure
     */
    public function create_signoff($data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_signoffs';
        
        $defaults = array(
            'project_id' => 0,
            'stage' => null,
            'signoff_type' => 'stage_completion',
            'status' => 'pending',
            'signed_by' => null,
            'signature_data' => null,
            'signed_at' => null,
        );
        
        $data = wp_parse_args($data, $defaults);
        
        // Sanitize data
        $insert_data = array(
            'project_id' => absint($data['project_id']),
            'stage' => $data['stage'] ? absint($data['stage']) : null,
            'signoff_type' => sanitize_text_field($data['signoff_type']),
            'status' => sanitize_text_field($data['status']),
            'signed_by' => $data['signed_by'] ? absint($data['signed_by']) : null,
            'signature_data' => $data['signature_data'],
            'signed_at' => $data['signed_at'],
        );
        
        $result = $wpdb->insert($table, $insert_data);
        
        if ($result === false) {
            return false;
        }
        
        $signoff_id = $wpdb->insert_id;
        
        do_action('kpt_signoff_created', $signoff_id, $data);
        
        return $signoff_id;
    }
    
    /**
     * Sign a signoff
     *
     * @param int $signoff_id Signoff ID
     * @param int $user_id User ID
     * @param string $signature_data Signature data (base64 image)
     * @return bool True on success, false on failure
     */
    public function sign_signoff($signoff_id, $user_id, $signature_data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_signoffs';
        
        $signoff = $this->get_signoff($signoff_id);
        if (!$signoff) {
            return false;
        }
        
        $update_data = array(
            'status' => 'signed',
            'signed_by' => $user_id,
            'signature_data' => $signature_data,
            'signed_at' => current_time('mysql'),
        );
        
        $result = $wpdb->update($table, $update_data, array('id' => $signoff_id));
        
        if ($result !== false) {
            do_action('kpt_signoff_signed', $signoff_id, $user_id);
            
            // Send notification
            $this->send_signoff_notification($signoff_id);
            
            // If stage completion, mark stage as complete
            if ($signoff->signoff_type === 'stage_completion' && $signoff->stage) {
                $this->mark_stage_complete($signoff->project_id, $signoff->stage);
            }
        }
        
        return $result !== false;
    }
    
    /**
     * Delete a signoff
     *
     * @param int $signoff_id Signoff ID
     * @return bool True on success, false on failure
     */
    public function delete_signoff($signoff_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_signoffs';
        
        $signoff = $this->get_signoff($signoff_id);
        if (!$signoff) {
            return false;
        }
        
        $result = $wpdb->delete($table, array('id' => $signoff_id), array('%d'));
        
        if ($result !== false) {
            do_action('kpt_signoff_deleted', $signoff_id, $signoff);
        }
        
        return $result !== false;
    }
    
    /**
     * Check if stage requires signoff
     *
     * @param int $project_id Project ID
     * @param int $stage Stage number
     * @return bool True if requires signoff, false otherwise
     */
    public function stage_requires_signoff($project_id, $stage) {
        // Check if signoff exists for this stage
        $signoff = $this->get_stage_signoff($project_id, $stage);
        return (bool) $signoff;
    }
    
    /**
     * Check if stage signoff is complete
     *
     * @param int $project_id Project ID
     * @param int $stage Stage number
     * @return bool True if signed, false otherwise
     */
    public function stage_signoff_complete($project_id, $stage) {
        $signoff = $this->get_stage_signoff($project_id, $stage);
        return $signoff && $signoff->status === 'signed';
    }
    
    /**
     * Get stage signoff
     *
     * @param int $project_id Project ID
     * @param int $stage Stage number
     * @return object|null Signoff object or null
     */
    private function get_stage_signoff($project_id, $stage) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_signoffs';
        
        return $wpdb->get_row($wpdb->prepare(
            "SELECT * FROM $table WHERE project_id = %d AND stage = %d AND signoff_type = 'stage_completion' ORDER BY id DESC LIMIT 1",
            $project_id,
            $stage
        ));
    }
    
    /**
     * Mark stage as complete
     *
     * @param int $project_id Project ID
     * @param int $stage Stage number
     */
    private function mark_stage_complete($project_id, $stage) {
        $current_stage = get_post_meta($project_id, '_kpt_project_stage', true);
        
        // Only advance stage if this is the current stage
        if ($current_stage == $stage) {
            update_post_meta($project_id, '_kpt_project_stage', $stage + 1);
            
            do_action('kpt_stage_completed', $project_id, $stage);
            
            // Send notification
            $this->send_stage_completed_notification($project_id, $stage);
        }
    }
    
    /**
     * Request signoff for stage
     *
     * @param int $project_id Project ID
     * @param int $stage Stage number
     * @return int|false Signoff ID on success, false on failure
     */
    public function request_stage_signoff($project_id, $stage) {
        // Check if signoff already exists
        $existing = $this->get_stage_signoff($project_id, $stage);
        if ($existing) {
            return false;
        }
        
        // Create signoff
        return $this->create_signoff(array(
            'project_id' => $project_id,
            'stage' => $stage,
            'signoff_type' => 'stage_completion',
            'status' => 'pending',
        ));
    }
    
    /**
     * Send signoff notification
     *
     * @param int $signoff_id Signoff ID
     */
    private function send_signoff_notification($signoff_id) {
        $signoff = $this->get_signoff($signoff_id);
        if (!$signoff) {
            return;
        }
        
        $project = get_post($signoff->project_id);
        if (!$project) {
            return;
        }
        
        // Notify project owner
        $owner = get_userdata($project->post_author);
        if (!$owner) {
            return;
        }
        
        $notification_handler = KPT_Notification_Handler::get_instance();
        
        $stage_text = $signoff->stage ? sprintf(__('Stage %d', 'kelbe-project-tracker'), $signoff->stage) : $signoff->signoff_type;
        
        $notification_handler->send_notification(
            $owner->user_email,
            sprintf(__('Signoff Completed: %s - %s', 'kelbe-project-tracker'), $project->post_title, $stage_text),
            'signoff_completed',
            array(
                'project_id' => $signoff->project_id,
                'project_title' => $project->post_title,
                'signoff_id' => $signoff_id,
                'stage' => $signoff->stage,
                'signoff_type' => $signoff->signoff_type,
            )
        );
    }
    
    /**
     * Send stage completed notification
     *
     * @param int $project_id Project ID
     * @param int $stage Stage number
     */
    private function send_stage_completed_notification($project_id, $stage) {
        $project = get_post($project_id);
        if (!$project) {
            return;
        }
        
        // Get all team members
        $team_manager = KPT_Team_Manager::get_instance();
        $members = $team_manager->get_team_members($project_id);
        
        if (empty($members)) {
            return;
        }
        
        $notification_handler = KPT_Notification_Handler::get_instance();
        
        // Notify all team members
        foreach ($members as $member) {
            if (isset($member->user_data['user_email'])) {
                $notification_handler->send_notification(
                    $member->user_data['user_email'],
                    sprintf(__('Stage Completed: %s', 'kelbe-project-tracker'), $project->post_title),
                    'stage_completed',
                    array(
                        'project_id' => $project_id,
                        'project_title' => $project->post_title,
                        'stage' => $stage,
                    )
                );
            }
        }
    }
    
    /**
     * Generate signoff link
     *
     * @param int $signoff_id Signoff ID
     * @return string Signoff URL
     */
    public function generate_signoff_link($signoff_id) {
        $token = $this->generate_signoff_token($signoff_id);
        return home_url('/signoff/' . $token);
    }
    
    /**
     * Generate signoff token
     *
     * @param int $signoff_id Signoff ID
     * @return string Token
     */
    private function generate_signoff_token($signoff_id) {
        return wp_hash($signoff_id . '-' . time());
    }
    
    /**
     * AJAX: Create signoff
     */
    public function ajax_create_signoff() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $project_id = isset($_POST['project_id']) ? absint($_POST['project_id']) : 0;
        
        if (!$project_id || !$this->user_can_manage_signoffs($project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $data = array(
            'project_id' => $project_id,
            'stage' => isset($_POST['stage']) ? absint($_POST['stage']) : null,
            'signoff_type' => isset($_POST['signoff_type']) ? sanitize_text_field($_POST['signoff_type']) : 'stage_completion',
        );
        
        $signoff_id = $this->create_signoff($data);
        
        if ($signoff_id) {
            wp_send_json_success(array(
                'message' => __('Signoff created.', 'kelbe-project-tracker'),
                'signoff_id' => $signoff_id,
                'signoff' => $this->get_signoff($signoff_id),
            ));
        } else {
            wp_send_json_error(__('Failed to create signoff.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Sign signoff
     */
    public function ajax_sign_signoff() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $signoff_id = isset($_POST['signoff_id']) ? absint($_POST['signoff_id']) : 0;
        $signoff = $this->get_signoff($signoff_id);
        
        if (!$signoff || !$this->user_can_sign($signoff->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $signature_data = isset($_POST['signature']) ? $_POST['signature'] : '';
        
        if (!$signature_data) {
            wp_send_json_error(__('Signature is required.', 'kelbe-project-tracker'));
        }
        
        $user_id = get_current_user_id();
        
        if ($this->sign_signoff($signoff_id, $user_id, $signature_data)) {
            wp_send_json_success(array(
                'message' => __('Signoff completed.', 'kelbe-project-tracker'),
                'signoff' => $this->get_signoff($signoff_id),
            ));
        } else {
            wp_send_json_error(__('Failed to complete signoff.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Sign signoff with token (no auth)
     */
    public function ajax_sign_signoff_token() {
        $token = isset($_POST['token']) ? sanitize_text_field($_POST['token']) : '';
        
        if (!$token) {
            wp_send_json_error(__('Invalid token.', 'kelbe-project-tracker'));
        }
        
        // This is a placeholder - in production, implement proper token validation
        // and retrieve the associated signoff
        
        wp_send_json_error(__('Token-based signoff not yet implemented.', 'kelbe-project-tracker'));
    }
    
    /**
     * AJAX: Get signoffs
     */
    public function ajax_get_signoffs() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $project_id = isset($_POST['project_id']) ? absint($_POST['project_id']) : 0;
        
        if (!$project_id) {
            wp_send_json_error(__('Project ID is required.', 'kelbe-project-tracker'));
        }
        
        $stage = isset($_POST['stage']) ? absint($_POST['stage']) : null;
        $status = isset($_POST['status']) ? sanitize_text_field($_POST['status']) : null;
        
        $signoffs = $this->get_signoffs($project_id, $stage, $status);
        
        wp_send_json_success($signoffs);
    }
    
    /**
     * AJAX: Delete signoff
     */
    public function ajax_delete_signoff() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $signoff_id = isset($_POST['signoff_id']) ? absint($_POST['signoff_id']) : 0;
        $signoff = $this->get_signoff($signoff_id);
        
        if (!$signoff || !$this->user_can_manage_signoffs($signoff->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        if ($this->delete_signoff($signoff_id)) {
            wp_send_json_success(__('Signoff deleted.', 'kelbe-project-tracker'));
        } else {
            wp_send_json_error(__('Failed to delete signoff.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * Check if user can manage signoffs for a project
     *
     * @param int $project_id Project ID
     * @return bool True if user can manage, false otherwise
     */
    private function user_can_manage_signoffs($project_id) {
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
    
    /**
     * Check if user can sign signoffs for a project
     *
     * @param int $project_id Project ID
     * @return bool True if user can sign, false otherwise
     */
    private function user_can_sign($project_id) {
        $user_id = get_current_user_id();
        
        // Admins can always sign
        if (current_user_can('manage_options')) {
            return true;
        }
        
        // Project author can sign
        $project = get_post($project_id);
        if ($project && $project->post_author == $user_id) {
            return true;
        }
        
        // Team members can sign
        $team_manager = KPT_Team_Manager::get_instance();
        $member = $team_manager->get_team_member($project_id, $user_id);
        
        return (bool) $member;
    }
}
