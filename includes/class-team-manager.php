<?php
/**
 * Team Manager
 *
 * Manages team member assignments to projects
 *
 * @package Kelbe_Project_Tracker
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Team Manager class
 */
class KPT_Team_Manager {
    
    /**
     * Single instance of the class
     *
     * @var KPT_Team_Manager
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return KPT_Team_Manager
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
        add_action('wp_ajax_kpt_add_team_member', array($this, 'ajax_add_member'));
        add_action('wp_ajax_kpt_update_team_member', array($this, 'ajax_update_member'));
        add_action('wp_ajax_kpt_remove_team_member', array($this, 'ajax_remove_member'));
        add_action('wp_ajax_kpt_get_team_members', array($this, 'ajax_get_members'));
    }
    
    /**
     * Get team members for a project
     *
     * @param int $project_id Project ID
     * @param string $role Optional role filter
     * @return array Team members
     */
    public function get_team_members($project_id, $role = null) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_team_members';
        
        $where = $wpdb->prepare('project_id = %d', $project_id);
        
        if ($role !== null) {
            $where .= $wpdb->prepare(' AND role = %s', $role);
        }
        
        $members = $wpdb->get_results("SELECT * FROM $table WHERE $where ORDER BY created_at ASC");
        
        // Enrich with user data
        foreach ($members as &$member) {
            $user = get_userdata($member->user_id);
            if ($user) {
                $member->user_data = array(
                    'display_name' => $user->display_name,
                    'user_email' => $user->user_email,
                    'user_login' => $user->user_login,
                    'avatar_url' => get_avatar_url($user->ID),
                );
            }
        }
        
        return $members;
    }
    
    /**
     * Get a single team member
     *
     * @param int $project_id Project ID
     * @param int $user_id User ID
     * @return object|null Team member or null
     */
    public function get_team_member($project_id, $user_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_team_members';
        
        return $wpdb->get_row($wpdb->prepare(
            "SELECT * FROM $table WHERE project_id = %d AND user_id = %d",
            $project_id,
            $user_id
        ));
    }
    
    /**
     * Get team member by ID
     *
     * @param int $member_id Member ID
     * @return object|null Team member or null
     */
    public function get_member_by_id($member_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_team_members';
        
        return $wpdb->get_row($wpdb->prepare("SELECT * FROM $table WHERE id = %d", $member_id));
    }
    
    /**
     * Add a team member to a project
     *
     * @param array $data Member data
     * @return int|false Member ID on success, false on failure
     */
    public function add_member($data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_team_members';
        
        // Check if member already exists
        $existing = $this->get_team_member($data['project_id'], $data['user_id']);
        if ($existing) {
            return false;
        }
        
        $defaults = array(
            'project_id' => 0,
            'user_id' => 0,
            'role' => 'member',
            'trade_type' => null,
            'permissions' => null,
            'added_by' => get_current_user_id(),
        );
        
        $data = wp_parse_args($data, $defaults);
        
        // Sanitize data
        $insert_data = array(
            'project_id' => absint($data['project_id']),
            'user_id' => absint($data['user_id']),
            'role' => sanitize_text_field($data['role']),
            'trade_type' => $data['trade_type'] ? sanitize_text_field($data['trade_type']) : null,
            'permissions' => $data['permissions'] ? wp_json_encode($data['permissions']) : null,
            'added_by' => absint($data['added_by']),
            'created_at' => current_time('mysql'),
        );
        
        $result = $wpdb->insert($table, $insert_data);
        
        if ($result === false) {
            return false;
        }
        
        $member_id = $wpdb->insert_id;
        
        do_action('kpt_team_member_added', $member_id, $data);
        
        // Send notification
        $this->send_member_added_notification($member_id);
        
        return $member_id;
    }
    
    /**
     * Update a team member
     *
     * @param int $member_id Member ID
     * @param array $data Member data
     * @return bool True on success, false on failure
     */
    public function update_member($member_id, $data) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_team_members';
        
        $member = $this->get_member_by_id($member_id);
        if (!$member) {
            return false;
        }
        
        $update_data = array();
        
        if (isset($data['role'])) {
            $update_data['role'] = sanitize_text_field($data['role']);
        }
        
        if (isset($data['trade_type'])) {
            $update_data['trade_type'] = $data['trade_type'] ? sanitize_text_field($data['trade_type']) : null;
        }
        
        if (isset($data['permissions'])) {
            $update_data['permissions'] = $data['permissions'] ? wp_json_encode($data['permissions']) : null;
        }
        
        $result = $wpdb->update($table, $update_data, array('id' => $member_id));
        
        if ($result !== false) {
            do_action('kpt_team_member_updated', $member_id, $data);
        }
        
        return $result !== false;
    }
    
    /**
     * Remove a team member from a project
     *
     * @param int $member_id Member ID
     * @return bool True on success, false on failure
     */
    public function remove_member($member_id) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_team_members';
        
        $member = $this->get_member_by_id($member_id);
        if (!$member) {
            return false;
        }
        
        $result = $wpdb->delete($table, array('id' => $member_id), array('%d'));
        
        if ($result !== false) {
            do_action('kpt_team_member_removed', $member_id, $member);
        }
        
        return $result !== false;
    }
    
    /**
     * Get all projects for a user
     *
     * @param int $user_id User ID
     * @param string $role Optional role filter
     * @return array Projects
     */
    public function get_user_projects($user_id, $role = null) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_team_members';
        
        $where = $wpdb->prepare('user_id = %d', $user_id);
        
        if ($role !== null) {
            $where .= $wpdb->prepare(' AND role = %s', $role);
        }
        
        return $wpdb->get_results("SELECT * FROM $table WHERE $where ORDER BY created_at DESC");
    }
    
    /**
     * Check if user is on project team
     *
     * @param int $project_id Project ID
     * @param int $user_id User ID
     * @return bool True if on team, false otherwise
     */
    public function is_on_team($project_id, $user_id) {
        return (bool) $this->get_team_member($project_id, $user_id);
    }
    
    /**
     * Check if user has specific role on project
     *
     * @param int $project_id Project ID
     * @param int $user_id User ID
     * @param string $role Role to check
     * @return bool True if has role, false otherwise
     */
    public function has_role($project_id, $user_id, $role) {
        $member = $this->get_team_member($project_id, $user_id);
        return $member && $member->role === $role;
    }
    
    /**
     * Get members by trade type
     *
     * @param int $project_id Project ID
     * @param string $trade_type Trade type
     * @return array Team members
     */
    public function get_members_by_trade($project_id, $trade_type) {
        global $wpdb;
        $table = $wpdb->prefix . 'kpt_team_members';
        
        return $wpdb->get_results($wpdb->prepare(
            "SELECT * FROM $table WHERE project_id = %d AND trade_type = %s ORDER BY created_at ASC",
            $project_id,
            $trade_type
        ));
    }
    
    /**
     * Send notification when member is added
     *
     * @param int $member_id Member ID
     */
    private function send_member_added_notification($member_id) {
        $member = $this->get_member_by_id($member_id);
        if (!$member) {
            return;
        }
        
        $user = get_userdata($member->user_id);
        $project = get_post($member->project_id);
        
        if (!$user || !$project) {
            return;
        }
        
        $notification_handler = KPT_Notification_Handler::get_instance();
        $notification_handler->send_notification(
            $user->user_email,
            sprintf(__('You\'ve been added to project: %s', 'kelbe-project-tracker'), $project->post_title),
            'team_member_added',
            array(
                'project_id' => $member->project_id,
                'project_title' => $project->post_title,
                'role' => $member->role,
                'trade_type' => $member->trade_type,
            )
        );
    }
    
    /**
     * AJAX: Add team member
     */
    public function ajax_add_member() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $project_id = isset($_POST['project_id']) ? absint($_POST['project_id']) : 0;
        
        if (!$project_id || !$this->user_can_manage_team($project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $data = array(
            'project_id' => $project_id,
            'user_id' => isset($_POST['user_id']) ? absint($_POST['user_id']) : 0,
            'role' => isset($_POST['role']) ? sanitize_text_field($_POST['role']) : 'member',
            'trade_type' => isset($_POST['trade_type']) ? sanitize_text_field($_POST['trade_type']) : null,
            'permissions' => isset($_POST['permissions']) ? $_POST['permissions'] : null,
        );
        
        if (!$data['user_id']) {
            wp_send_json_error(__('User ID is required.', 'kelbe-project-tracker'));
        }
        
        $member_id = $this->add_member($data);
        
        if ($member_id) {
            wp_send_json_success(array(
                'message' => __('Team member added.', 'kelbe-project-tracker'),
                'member_id' => $member_id,
                'member' => $this->get_member_by_id($member_id),
            ));
        } else {
            wp_send_json_error(__('Failed to add team member. User may already be on the team.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Update team member
     */
    public function ajax_update_member() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $member_id = isset($_POST['member_id']) ? absint($_POST['member_id']) : 0;
        $member = $this->get_member_by_id($member_id);
        
        if (!$member || !$this->user_can_manage_team($member->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        $data = array();
        
        if (isset($_POST['role'])) {
            $data['role'] = sanitize_text_field($_POST['role']);
        }
        
        if (isset($_POST['trade_type'])) {
            $data['trade_type'] = sanitize_text_field($_POST['trade_type']);
        }
        
        if (isset($_POST['permissions'])) {
            $data['permissions'] = $_POST['permissions'];
        }
        
        if ($this->update_member($member_id, $data)) {
            wp_send_json_success(array(
                'message' => __('Team member updated.', 'kelbe-project-tracker'),
                'member' => $this->get_member_by_id($member_id),
            ));
        } else {
            wp_send_json_error(__('Failed to update team member.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Remove team member
     */
    public function ajax_remove_member() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $member_id = isset($_POST['member_id']) ? absint($_POST['member_id']) : 0;
        $member = $this->get_member_by_id($member_id);
        
        if (!$member || !$this->user_can_manage_team($member->project_id)) {
            wp_send_json_error(__('Permission denied.', 'kelbe-project-tracker'));
        }
        
        if ($this->remove_member($member_id)) {
            wp_send_json_success(__('Team member removed.', 'kelbe-project-tracker'));
        } else {
            wp_send_json_error(__('Failed to remove team member.', 'kelbe-project-tracker'));
        }
    }
    
    /**
     * AJAX: Get team members
     */
    public function ajax_get_members() {
        check_ajax_referer('kpt_nonce', 'nonce');
        
        $project_id = isset($_POST['project_id']) ? absint($_POST['project_id']) : 0;
        
        if (!$project_id) {
            wp_send_json_error(__('Project ID is required.', 'kelbe-project-tracker'));
        }
        
        $members = $this->get_team_members($project_id);
        wp_send_json_success($members);
    }
    
    /**
     * Check if user can manage team for a project
     *
     * @param int $project_id Project ID
     * @return bool True if user can manage, false otherwise
     */
    private function user_can_manage_team($project_id) {
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
